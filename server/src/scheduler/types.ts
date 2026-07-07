/** Plain-data scheduler types — no DB coupling so the core is unit-testable. */

export interface SchedulerItem {
  id: string;
  type: string;
  title: string;
  status: "open" | "done";
  dueAt: Date | null;
  startAt: Date | null;
  endAt: Date | null;
  notBeforeAt: Date | null;
  estimatedMinutes: number | null;
  dependsOn: string[];
}

export interface DayWindow {
  date: string; // YYYY-MM-DD in the firm timezone
  startMinutes: number;
  endMinutes: number;
}

export interface DaySlot {
  date: string;
  startMinutes: number;
  endMinutes: number;
}

export interface PlannedBlock {
  date: string;
  startMinutes: number;
  endMinutes: number;
  label: string;
  kind: "event" | "todo_batch";
  itemIds: string[];
}

export interface SchedulerInput {
  now: Date;
  timezone: string;
  windows: DayWindow[];
  items: SchedulerItem[];
}

export const DEFAULT_ESTIMATE_MINUTES = 30;

export function estimateOf(item: SchedulerItem): number {
  return item.estimatedMinutes ?? DEFAULT_ESTIMATE_MINUTES;
}
