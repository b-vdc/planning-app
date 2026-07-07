export interface UserDto {
  id: string;
  name: string;
  color: string;
}

export interface ItemDto {
  id: string;
  type: string;
  title: string;
  description: string;
  status: "open" | "done";
  doneAt: string | null;
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  notBeforeAt: string | null;
  estimatedMinutes: number | null;
  extra: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dependsOn: string[]; // item ids this item depends on
  guests: string[]; // user ids
}

export interface WorkWindowDto {
  date: string; // YYYY-MM-DD
  startMinutes: number;
  endMinutes: number;
  /** true when the window comes from the weekly default rather than a per-day override */
  isDefault: boolean;
}

export interface ScheduleBlockDto {
  id: string;
  userId: string;
  date: string; // YYYY-MM-DD
  startMinutes: number;
  endMinutes: number;
  label: string;
  kind: "event" | "todo_batch";
  itemIds: string[];
}

export interface AgendaDto {
  blocks: ScheduleBlockDto[];
  items: Record<string, ItemDto>;
  workWindows: WorkWindowDto[];
}

export interface SettingsDto {
  planningHorizonDays: number;
  recalcCron: string;
  timezone: string; // IANA name, e.g. Europe/Brussels — work windows are wall-clock in this zone
}
