/**
 * Platform-side validator: deterministically re-checks every hard constraint on a
 * proposed plan (LLM or baseline). Violations are returned as human/LLM-readable
 * strings and fed back to the model in the correction loop.
 */
import { fromWallClock } from "./time.js";
import {
  estimateOf,
  type DayWindow,
  type PlannedBlock,
  type SchedulerItem,
} from "./types.js";

export interface ValidateInput {
  plan: PlannedBlock[]; // todo_batch blocks proposed by the LLM (or baseline)
  eventBlocks: PlannedBlock[];
  windows: DayWindow[];
  items: Map<string, SchedulerItem>;
  /** Item ids that must appear in the plan exactly once. */
  requiredItemIds: string[];
  now: Date;
  timezone: string;
}

export function validatePlan(input: ValidateInput): string[] {
  const { plan, eventBlocks, windows, items, requiredItemIds, timezone: tz } = input;
  const violations: string[] = [];
  const windowByDate = new Map(windows.map((w) => [w.date, w]));

  // -- placement coverage ----------------------------------------------------
  const placedIn = new Map<string, PlannedBlock[]>();
  for (const block of plan) {
    for (const id of block.itemIds) {
      (placedIn.get(id) ?? placedIn.set(id, []).get(id)!).push(block);
    }
  }
  for (const id of requiredItemIds) {
    const blocks = placedIn.get(id) ?? [];
    if (blocks.length === 0) violations.push(`Item ${id} is not placed in any block`);
    if (blocks.length > 1) violations.push(`Item ${id} is placed in ${blocks.length} blocks; it must appear exactly once`);
  }
  const required = new Set(requiredItemIds);
  for (const id of placedIn.keys()) {
    if (!required.has(id)) violations.push(`Item ${id} is unknown or not schedulable and must not be placed`);
  }

  // -- block shape / windows / overlaps --------------------------------------
  for (const block of plan) {
    const desc = `Block "${block.label}" on ${block.date} ${fmt(block.startMinutes)}-${fmt(block.endMinutes)}`;
    if (block.endMinutes <= block.startMinutes) {
      violations.push(`${desc}: end must be after start`);
      continue;
    }
    const win = windowByDate.get(block.date);
    if (!win) {
      violations.push(`${desc}: no working time configured on ${block.date}`);
      continue;
    }
    if (block.startMinutes < win.startMinutes || block.endMinutes > win.endMinutes) {
      violations.push(
        `${desc}: outside the work window ${fmt(win.startMinutes)}-${fmt(win.endMinutes)}`,
      );
    }
    for (const ev of eventBlocks) {
      if (ev.date === block.date && overlaps(block, ev)) {
        violations.push(`${desc}: overlaps the event "${ev.label}" (${fmt(ev.startMinutes)}-${fmt(ev.endMinutes)})`);
      }
    }
    const capacity = block.endMinutes - block.startMinutes;
    const needed = block.itemIds.reduce((sum, id) => {
      const item = items.get(id);
      return sum + (item ? estimateOf(item) : 0);
    }, 0);
    if (needed > capacity) {
      violations.push(`${desc}: items need ${needed} minutes but the block is only ${capacity} minutes long`);
    }
  }
  for (let i = 0; i < plan.length; i++) {
    for (let j = i + 1; j < plan.length; j++) {
      if (plan[i].date === plan[j].date && overlaps(plan[i], plan[j])) {
        violations.push(
          `Blocks "${plan[i].label}" and "${plan[j].label}" overlap on ${plan[i].date}`,
        );
      }
    }
  }

  // Per-item execution times: within a block, itemIds order is execution order,
  // so each item runs at blockStart + sum of the estimates before it.
  const itemTimes = new Map<string, { start: Date; end: Date }>();
  for (const block of plan) {
    let offset = 0;
    for (const id of block.itemIds) {
      const item = items.get(id);
      if (!item) continue;
      const start = fromWallClock(block.date, block.startMinutes + offset, tz);
      offset += estimateOf(item);
      const end = fromWallClock(block.date, block.startMinutes + offset, tz);
      if (!itemTimes.has(id)) itemTimes.set(id, { start, end });
    }
  }

  // -- per-item date constraints ----------------------------------------------
  for (const [id, times] of itemTimes) {
    const item = items.get(id);
    if (!item || (placedIn.get(id)?.length ?? 0) !== 1) continue;
    if (item.notBeforeAt && times.start < item.notBeforeAt) {
      violations.push(
        `"${item.title}" (${id}) starts at ${times.start.toISOString()} before its do-not-start-before date ${item.notBeforeAt.toISOString()}`,
      );
    }
    if (item.dueAt && times.end > item.dueAt) {
      violations.push(
        `"${item.title}" (${id}) finishes at ${times.end.toISOString()} after its due date ${item.dueAt.toISOString()}`,
      );
    }
  }

  // -- dependency ordering -----------------------------------------------------
  for (const [id, times] of itemTimes) {
    const item = items.get(id);
    if (!item || (placedIn.get(id)?.length ?? 0) !== 1) continue;
    for (const depId of item.dependsOn) {
      const dep = items.get(depId);
      if (!dep) continue;
      if (dep.status === "done") continue;
      const depTimes = itemTimes.get(depId);
      if (depTimes) {
        if (depTimes.end > times.start) {
          violations.push(
            `"${item.title}" (${id}) starts before its dependency "${dep.title}" (${depId}) is finished`,
          );
        }
      } else if (dep.endAt && dep.endAt > times.start) {
        // fixed event dependency
        violations.push(
          `"${item.title}" (${id}) starts before the event "${dep.title}" it depends on has ended`,
        );
      }
    }
  }

  return violations;
}

function overlaps(
  a: { startMinutes: number; endMinutes: number },
  b: { startMinutes: number; endMinutes: number },
): boolean {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
