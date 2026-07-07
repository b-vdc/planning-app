import { describe, expect, it } from "vitest";
import { deterministicPlan, topoSortTodos } from "../src/scheduler/deterministic.js";
import { fromWallClock, toWallClock } from "../src/scheduler/time.js";
import type { DayWindow, SchedulerInput, SchedulerItem } from "../src/scheduler/types.js";
import { validatePlan } from "../src/scheduler/validate.js";

const TZ = "Europe/Brussels";
// Monday 2030-01-07, 08:00 Brussels (winter, CET = UTC+1)
const NOW = new Date("2030-01-07T07:00:00Z");

let seq = 0;
function mkItem(partial: Partial<SchedulerItem> & { title: string }): SchedulerItem {
  return {
    id: partial.id ?? `item-${++seq}`,
    type: partial.type ?? "todo",
    status: partial.status ?? "open",
    dueAt: null,
    startAt: null,
    endAt: null,
    notBeforeAt: null,
    estimatedMinutes: 60,
    dependsOn: [],
    ...partial,
  };
}

function windows(days: string[], start = 9 * 60, end = 17 * 60): DayWindow[] {
  return days.map((date) => ({ date, startMinutes: start, endMinutes: end }));
}

const DAYS = ["2030-01-07", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-11"];

function input(items: SchedulerItem[], w: DayWindow[] = windows(DAYS)): SchedulerInput {
  return { now: NOW, timezone: TZ, windows: w, items };
}

function validateBaseline(items: SchedulerItem[], w: DayWindow[] = windows(DAYS)) {
  const det = deterministicPlan(input(items, w));
  const violations = validatePlan({
    plan: det.baselineTodoBlocks,
    eventBlocks: det.eventBlocks,
    windows: w,
    items: new Map(items.map((i) => [i.id, i])),
    requiredItemIds: det.baselineTodoBlocks.flatMap((b) => b.itemIds),
    now: NOW,
    timezone: TZ,
  });
  return { det, violations };
}

describe("time helpers", () => {
  it("round-trips wall clock through DST-less winter", () => {
    const d = fromWallClock("2030-01-07", 9 * 60, TZ);
    expect(d.toISOString()).toBe("2030-01-07T08:00:00.000Z");
    expect(toWallClock(d, TZ)).toEqual({ date: "2030-01-07", minutes: 9 * 60 });
  });
  it("handles summer time", () => {
    const d = fromWallClock("2030-07-08", 9 * 60, TZ);
    expect(d.toISOString()).toBe("2030-07-08T07:00:00.000Z"); // CEST = UTC+2
  });
});

describe("topoSortTodos", () => {
  it("orders dependencies before dependents", () => {
    const a = mkItem({ id: "a", title: "A" });
    const b = mkItem({ id: "b", title: "B", dependsOn: ["a"] });
    const c = mkItem({ id: "c", title: "C", dependsOn: ["b"] });
    const byId = new Map([a, b, c].map((i) => [i.id, i]));
    const order = topoSortTodos([c, b, a], byId, NOW).map((i) => i.id);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("throws on cycles", () => {
    const a = mkItem({ id: "a", title: "A", dependsOn: ["b"] });
    const b = mkItem({ id: "b", title: "B", dependsOn: ["a"] });
    const byId = new Map([a, b].map((i) => [i.id, i]));
    expect(() => topoSortTodos([a, b], byId, NOW)).toThrow(/cycle/i);
  });

  it("ignores dependencies on done items", () => {
    const a = mkItem({ id: "a", title: "A", status: "done" });
    const b = mkItem({ id: "b", title: "B", dependsOn: ["a"] });
    const byId = new Map([a, b].map((i) => [i.id, i]));
    expect(topoSortTodos([b], byId, NOW).map((i) => i.id)).toEqual(["b"]);
  });
});

describe("deterministicPlan", () => {
  it("produces a baseline that passes the validator", () => {
    const items = [
      mkItem({ id: "ev", title: "Meeting", type: "event",
        startAt: fromWallClock("2030-01-07", 10 * 60, TZ),
        endAt: fromWallClock("2030-01-07", 12 * 60, TZ) }),
      mkItem({ id: "a", title: "A", dueAt: fromWallClock("2030-01-09", 17 * 60, TZ), estimatedMinutes: 90 }),
      mkItem({ id: "b", title: "B", dependsOn: ["a"], estimatedMinutes: 30 }),
      mkItem({ id: "c", title: "C", notBeforeAt: fromWallClock("2030-01-08", 9 * 60, TZ) }),
    ];
    const { det, violations } = validateBaseline(items);
    expect(violations).toEqual([]);
    expect(det.baselineTodoBlocks.flatMap((b) => b.itemIds).sort()).toEqual(["a", "b", "c"]);
  });

  it("never schedules before not-before dates", () => {
    const items = [
      mkItem({ id: "c", title: "C", notBeforeAt: fromWallClock("2030-01-09", 9 * 60, TZ) }),
    ];
    const { det } = validateBaseline(items);
    const block = det.baselineTodoBlocks.find((b) => b.itemIds.includes("c"))!;
    expect(block.date >= "2030-01-09").toBe(true);
  });

  it("never schedules in the past (before now)", () => {
    const items = [mkItem({ id: "a", title: "A" })];
    const { det } = validateBaseline(items);
    const block = det.baselineTodoBlocks[0];
    const start = fromWallClock(block.date, block.startMinutes, TZ);
    expect(start.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  });

  it("carves fixed events out of the day capacity", () => {
    const items = [
      mkItem({ id: "ev", title: "All-morning", type: "event",
        startAt: fromWallClock("2030-01-07", 9 * 60, TZ),
        endAt: fromWallClock("2030-01-07", 13 * 60, TZ) }),
      mkItem({ id: "a", title: "A", estimatedMinutes: 120 }),
    ];
    const { det, violations } = validateBaseline(items);
    expect(violations).toEqual([]);
    const block = det.baselineTodoBlocks[0];
    if (block.date === "2030-01-07") expect(block.startMinutes).toBeGreaterThanOrEqual(13 * 60);
  });

  it("keeps dependents after their dependencies", () => {
    const items = [
      mkItem({ id: "a", title: "A", estimatedMinutes: 300 }),
      mkItem({ id: "b", title: "B", dependsOn: ["a"], estimatedMinutes: 60 }),
    ];
    const { det, violations } = validateBaseline(items);
    expect(violations).toEqual([]); // includes the intra-block dependency-order check
    const blockOf = (id: string) => det.baselineTodoBlocks.find((b) => b.itemIds.includes(id))!;
    const aBlock = blockOf("a");
    const bBlock = blockOf("b");
    if (aBlock === bBlock) {
      // same block: execution order = itemIds order
      expect(aBlock.itemIds.indexOf("a")).toBeLessThan(aBlock.itemIds.indexOf("b"));
    } else {
      const aEnd = fromWallClock(aBlock.date, aBlock.endMinutes, TZ);
      const bStart = fromWallClock(bBlock.date, bBlock.startMinutes, TZ);
      expect(bStart.getTime()).toBeGreaterThanOrEqual(aEnd.getTime());
    }
  });

  it("warns when a due date cannot be met", () => {
    const items = [
      mkItem({ id: "a", title: "Huge", estimatedMinutes: 8 * 60,
        dueAt: fromWallClock("2030-01-07", 10 * 60, TZ) }),
    ];
    const { det } = validateBaseline(items);
    expect(det.warnings.some((w) => w.includes("due date"))).toBe(true);
  });

  it("warns when an item does not fit in the horizon", () => {
    const items = [mkItem({ id: "a", title: "Massive", estimatedMinutes: 10_000 })];
    const { det } = validateBaseline(items);
    expect(det.warnings.some((w) => w.includes("horizon"))).toBe(true);
  });

  it("excludes done items and past events", () => {
    const items = [
      mkItem({ id: "done", title: "Done", status: "done" }),
      mkItem({ id: "past", title: "Past event", type: "event",
        startAt: new Date("2030-01-06T09:00:00Z"), endAt: new Date("2030-01-06T10:00:00Z") }),
      mkItem({ id: "a", title: "A" }),
    ];
    const det = deterministicPlan(input(items));
    expect(det.todos.map((t) => t.id)).toEqual(["a"]);
    expect(det.eventBlocks).toEqual([]);
  });
});

describe("validatePlan", () => {
  const items = [
    mkItem({ id: "a", title: "A", estimatedMinutes: 60,
      dueAt: fromWallClock("2030-01-08", 17 * 60, TZ) }),
    mkItem({ id: "b", title: "B", estimatedMinutes: 30, dependsOn: ["a"] }),
  ];
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const base = {
    eventBlocks: [],
    windows: windows(DAYS),
    items: itemMap,
    requiredItemIds: ["a", "b"],
    now: NOW,
    timezone: TZ,
  };
  const block = (date: string, s: number, e: number, ids: string[], label = "Todos") => ({
    date, startMinutes: s, endMinutes: e, label, kind: "todo_batch" as const, itemIds: ids,
  });

  it("accepts a valid plan", () => {
    const plan = [block("2030-01-07", 9 * 60, 10 * 60, ["a"]), block("2030-01-07", 10 * 60, 11 * 60, ["b"])];
    expect(validatePlan({ ...base, plan })).toEqual([]);
  });

  it("flags missing and duplicate placements", () => {
    const plan = [block("2030-01-07", 9 * 60, 11 * 60, ["a", "a"])];
    const v = validatePlan({ ...base, plan });
    expect(v.join("\n")).toMatch(/b is not placed/);
    expect(v.join("\n")).toMatch(/placed in 2 blocks/);
  });

  it("flags blocks outside the work window", () => {
    const plan = [block("2030-01-07", 7 * 60, 8 * 60, ["a"]), block("2030-01-07", 10 * 60, 11 * 60, ["b"])];
    expect(validatePlan({ ...base, plan }).join("\n")).toMatch(/outside the work window/);
  });

  it("flags overlap with events", () => {
    const ev = { date: "2030-01-07", startMinutes: 9 * 60, endMinutes: 10 * 60,
      label: "Meeting", kind: "event" as const, itemIds: ["ev"] };
    const plan = [block("2030-01-07", 9 * 60 + 30, 10 * 60 + 30, ["a"]), block("2030-01-07", 11 * 60, 12 * 60, ["b"])];
    expect(validatePlan({ ...base, eventBlocks: [ev], plan }).join("\n")).toMatch(/overlaps the event/);
  });

  it("flags undersized blocks", () => {
    const plan = [block("2030-01-07", 9 * 60, 9 * 60 + 30, ["a"]), block("2030-01-07", 10 * 60, 11 * 60, ["b"])];
    expect(validatePlan({ ...base, plan }).join("\n")).toMatch(/only 30 minutes/);
  });

  it("flags due-date violations", () => {
    const plan = [block("2030-01-09", 9 * 60, 10 * 60, ["a"]), block("2030-01-09", 10 * 60, 11 * 60, ["b"])];
    expect(validatePlan({ ...base, plan }).join("\n")).toMatch(/after its due date/);
  });

  it("flags dependency-order violations", () => {
    const plan = [block("2030-01-08", 9 * 60, 10 * 60, ["a"]), block("2030-01-07", 9 * 60, 10 * 60, ["b"])];
    expect(validatePlan({ ...base, plan }).join("\n")).toMatch(/starts before its dependency/);
  });

  it("flags overlapping todo blocks", () => {
    const plan = [block("2030-01-07", 9 * 60, 11 * 60, ["a"]), block("2030-01-07", 10 * 60, 12 * 60, ["b"])];
    expect(validatePlan({ ...base, plan }).join("\n")).toMatch(/overlap on 2030-01-07/);
  });
});
