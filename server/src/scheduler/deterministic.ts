/**
 * Deterministic scheduling pass. Enforces every hard constraint without any LLM:
 *  - dependency ordering (topological),
 *  - do-not-start-before dates,
 *  - due dates (violations reported as warnings when infeasible),
 *  - daily work windows minus fixed events.
 * Produces a feasible baseline plan; the LLM soft pass only regroups/paces
 * inside the bounds computed here.
 */
import { isFixed } from "@vdv/shared";
import { compareDay, fromWallClock, toWallClock } from "./time.js";
import {
  estimateOf,
  type DaySlot,
  type PlannedBlock,
  type SchedulerInput,
  type SchedulerItem,
} from "./types.js";

export interface ItemBounds {
  /** Earliest allowed start from now / not-before / fixed-event dependencies. */
  earliest: Date;
  latest: Date | null; // due date
}

export interface DeterministicResult {
  eventBlocks: PlannedBlock[];
  /** Feasible baseline placement of all todos (already respects every hard constraint). */
  baselineTodoBlocks: PlannedBlock[];
  /** Capacity left per day after fixed events. */
  freeSlots: DaySlot[];
  /** Open flexible items the plan must place. */
  todos: SchedulerItem[];
  bounds: Map<string, ItemBounds>;
  /** Topologically ordered dependency edges among open todos: [itemId, dependsOnId]. */
  todoDependencyEdges: [string, string][];
  warnings: string[];
}

function isPastEvent(item: SchedulerItem, now: Date): boolean {
  return isFixed(item.type) && item.endAt !== null && item.endAt.getTime() <= now.getTime();
}

/** A dependency is satisfied (no ordering constraint left) when done or already in the past. */
function depSatisfied(dep: SchedulerItem | undefined, now: Date): boolean {
  if (!dep) return true; // unknown id: nothing we can order against
  return dep.status === "done" || isPastEvent(dep, now);
}

export function topoSortTodos(
  todos: SchedulerItem[],
  byId: Map<string, SchedulerItem>,
  now: Date,
): SchedulerItem[] {
  const inTodo = new Set(todos.map((t) => t.id));
  const indegree = new Map<string, number>(todos.map((t) => [t.id, 0]));
  const dependents = new Map<string, string[]>();

  for (const t of todos) {
    for (const depId of t.dependsOn) {
      if (!inTodo.has(depId)) continue; // fixed events / done deps constrain bounds, not order
      if (depSatisfied(byId.get(depId), now)) continue;
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      (dependents.get(depId) ?? dependents.set(depId, []).get(depId)!).push(t.id);
    }
  }

  const queue = todos.filter((t) => (indegree.get(t.id) ?? 0) === 0);
  const order: SchedulerItem[] = [];
  while (queue.length) {
    // stable: among ready items prefer earlier due date, then shorter estimate
    queue.sort((a, b) => {
      const da = a.dueAt?.getTime() ?? Infinity;
      const dbb = b.dueAt?.getTime() ?? Infinity;
      if (da !== dbb) return da - dbb;
      return estimateOf(a) - estimateOf(b);
    });
    const next = queue.shift()!;
    order.push(next);
    for (const depId of dependents.get(next.id) ?? []) {
      const deg = indegree.get(depId)! - 1;
      indegree.set(depId, deg);
      if (deg === 0) queue.push(byId.get(depId)!);
    }
  }
  if (order.length !== todos.length) {
    throw new Error("Dependency cycle detected among open todos");
  }
  return order;
}

function eventBlocksFor(
  events: SchedulerItem[],
  windowDates: Set<string>,
  tz: string,
): PlannedBlock[] {
  const blocks: PlannedBlock[] = [];
  for (const ev of events) {
    const start = toWallClock(ev.startAt!, tz);
    const end = toWallClock(ev.endAt!, tz);
    // Split multi-day events into per-day segments.
    let d = start.date;
    while (compareDay(d, end.date) <= 0) {
      const s = d === start.date ? start.minutes : 0;
      const e = d === end.date ? end.minutes : 24 * 60;
      if (e > s && windowDates.has(d)) {
        blocks.push({
          date: d,
          startMinutes: s,
          endMinutes: e,
          label: ev.title,
          kind: "event",
          itemIds: [ev.id],
        });
      }
      const nextDay = new Date(`${d}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      d = nextDay.toISOString().slice(0, 10);
    }
  }
  return blocks;
}

function subtractEvents(input: SchedulerInput, eventBlocks: PlannedBlock[]): DaySlot[] {
  const slots: DaySlot[] = [];
  for (const w of input.windows) {
    let daySlots: DaySlot[] = [
      { date: w.date, startMinutes: w.startMinutes, endMinutes: w.endMinutes },
    ];
    for (const ev of eventBlocks.filter((b) => b.date === w.date)) {
      daySlots = daySlots.flatMap((s) => {
        if (ev.endMinutes <= s.startMinutes || ev.startMinutes >= s.endMinutes) return [s];
        const out: DaySlot[] = [];
        if (ev.startMinutes > s.startMinutes)
          out.push({ date: s.date, startMinutes: s.startMinutes, endMinutes: ev.startMinutes });
        if (ev.endMinutes < s.endMinutes)
          out.push({ date: s.date, startMinutes: ev.endMinutes, endMinutes: s.endMinutes });
        return out;
      });
    }
    slots.push(...daySlots.filter((s) => s.endMinutes - s.startMinutes >= 5));
  }
  slots.sort((a, b) => compareDay(a.date, b.date) || a.startMinutes - b.startMinutes);
  return slots;
}

export function deterministicPlan(input: SchedulerInput): DeterministicResult {
  const { now, timezone: tz } = input;
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const warnings: string[] = [];

  const open = input.items.filter((i) => i.status === "open");
  const futureEvents = open.filter(
    (i) => isFixed(i.type) && i.startAt && i.endAt && !isPastEvent(i, now),
  );
  const todos = open.filter((i) => !isFixed(i.type));

  const windowDates = new Set(input.windows.map((w) => w.date));
  const eventBlocks = eventBlocksFor(futureEvents, windowDates, tz);
  const freeSlots = subtractEvents(input, eventBlocks);

  // Bounds from static constraints (now, not-before, non-todo dependencies).
  const bounds = new Map<string, ItemBounds>();
  for (const t of todos) {
    let earliest = now;
    if (t.notBeforeAt && t.notBeforeAt > earliest) earliest = t.notBeforeAt;
    for (const depId of t.dependsOn) {
      const dep = byId.get(depId);
      if (!dep || depSatisfied(dep, now)) continue;
      if (isFixed(dep.type) && dep.endAt && dep.endAt > earliest) earliest = dep.endAt;
    }
    bounds.set(t.id, { earliest, latest: t.dueAt });
  }

  const order = topoSortTodos(todos, byId, now);
  const todoDependencyEdges: [string, string][] = [];
  const todoIds = new Set(todos.map((t) => t.id));
  for (const t of todos) {
    for (const depId of t.dependsOn) {
      if (todoIds.has(depId) && !depSatisfied(byId.get(depId), now)) {
        todoDependencyEdges.push([t.id, depId]);
      }
    }
  }

  // EDF packing into free slots, in topological order.
  const mutable = freeSlots.map((s) => ({ ...s }));
  const scheduledEnd = new Map<string, Date>(); // dep id -> absolute end of its placement
  const placements: { item: SchedulerItem; date: string; start: number; end: number }[] = [];

  for (const item of order) {
    const b = bounds.get(item.id)!;
    let earliest = b.earliest;
    for (const depId of item.dependsOn) {
      const depEnd = scheduledEnd.get(depId);
      if (depEnd && depEnd > earliest) earliest = depEnd;
    }
    const duration = estimateOf(item);

    let placed = false;
    for (const slot of mutable) {
      const slotStartAbs = fromWallClock(slot.date, slot.startMinutes, tz);
      const slotEndAbs = fromWallClock(slot.date, slot.endMinutes, tz);
      const startAbs = earliest > slotStartAbs ? earliest : slotStartAbs;
      if (startAbs >= slotEndAbs) continue;
      const startMin =
        earliest > slotStartAbs ? toWallClock(earliest, tz).minutes : slot.startMinutes;
      if (slot.endMinutes - startMin < duration) continue;

      const endMin = startMin + duration;
      placements.push({ item, date: slot.date, start: startMin, end: endMin });
      scheduledEnd.set(item.id, fromWallClock(slot.date, endMin, tz));
      if (b.latest && fromWallClock(slot.date, endMin, tz) > b.latest) {
        warnings.push(
          `"${item.title}" cannot be finished before its due date — scheduled ${slot.date} anyway`,
        );
      }
      // consume slot capacity (leading gap before `startMin` stays available)
      if (startMin > slot.startMinutes) {
        mutable.push({ date: slot.date, startMinutes: slot.startMinutes, endMinutes: startMin });
      }
      slot.startMinutes = endMin;
      mutable.sort((a, s) => compareDay(a.date, s.date) || a.startMinutes - s.startMinutes);
      placed = true;
      break;
    }
    if (!placed) {
      warnings.push(
        `"${item.title}" does not fit inside the planning horizon — increase the horizon or free up time`,
      );
    }
  }

  // Merge contiguous placements per day into baseline "Todos" blocks.
  placements.sort((a, b) => compareDay(a.date, b.date) || a.start - b.start);
  const baselineTodoBlocks: PlannedBlock[] = [];
  for (const p of placements) {
    const last = baselineTodoBlocks[baselineTodoBlocks.length - 1];
    if (last && last.date === p.date && last.endMinutes === p.start) {
      last.endMinutes = p.end;
      last.itemIds.push(p.item.id);
    } else {
      baselineTodoBlocks.push({
        date: p.date,
        startMinutes: p.start,
        endMinutes: p.end,
        label: "Todos",
        kind: "todo_batch",
        itemIds: [p.item.id],
      });
    }
  }

  return {
    eventBlocks,
    baselineTodoBlocks,
    freeSlots,
    todos,
    bounds,
    todoDependencyEdges,
    warnings,
  };
}
