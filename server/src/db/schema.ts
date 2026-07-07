import { randomUUID } from "node:crypto";
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#4f6d7a"),
});

/**
 * The polymorphic "item". Fields the scheduler queries hard against are real
 * typed columns; open-ended optional fields live in the JSONB `extra` column,
 * so new item types / optional fields need no migration.
 */
export const items = pgTable(
  "items",
  {
    id: id(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    notBeforeAt: timestamp("not_before_at", { withTimezone: true }),
    estimatedMinutes: integer("estimated_minutes"),
    extra: jsonb("extra").notNull().default({}),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("items_status_due_idx").on(t.status, t.dueAt),
    index("items_start_idx").on(t.startAt),
    index("items_type_idx").on(t.type),
  ],
);

/** Dependencies are first-class: a real join table the scheduler traverses. */
export const itemDependencies = pgTable(
  "item_dependencies",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.dependsOnId] })],
);

export const itemGuests = pgTable(
  "item_guests",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.userId] })],
);

/** Per-day override of a user's working window. */
export const workWindows = pgTable(
  "work_windows",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    startMinutes: integer("start_minutes").notNull(),
    endMinutes: integer("end_minutes").notNull(),
  },
  (t) => [index("work_windows_user_date_idx").on(t.userId, t.date)],
);

/** Weekly template (0 = Sunday … 6 = Saturday); a per-date row wins over this. */
export const workWindowDefaults = pgTable(
  "work_window_defaults",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    startMinutes: integer("start_minutes").notNull(),
    endMinutes: integer("end_minutes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.weekday] })],
);

/** Output of a scheduler run; replaced transactionally per user from today forward. */
export const scheduleBlocks = pgTable(
  "schedule_blocks",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    startMinutes: integer("start_minutes").notNull(),
    endMinutes: integer("end_minutes").notNull(),
    label: text("label").notNull(),
    kind: text("kind", { enum: ["event", "todo_batch"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_blocks_user_date_idx").on(t.userId, t.date)],
);

export const scheduleBlockItems = pgTable(
  "schedule_block_items",
  {
    blockId: text("block_id")
      .notNull()
      .references(() => scheduleBlocks.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.blockId, t.itemId] })],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
