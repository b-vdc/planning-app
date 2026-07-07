/**
 * Item-type registry. Item types and their fields are data, not schema:
 * adding a type or a new optional field here requires no DB migration —
 * native fields map to typed columns, optional non-core fields land in
 * the item's JSONB `extra` column.
 */

/** Fields backed by typed, indexed columns on the items table. */
export type CoreField =
  | "dueAt"
  | "startAt"
  | "endAt"
  | "notBeforeAt"
  | "estimatedMinutes"
  | "guests";

/** Optional fields stored in the JSONB `extra` column. */
export interface ExtraFieldDef {
  key: string;
  label: string;
  input: "text" | "date" | "datetime";
}

export interface ItemTypeDef {
  type: string;
  label: string;
  /** Shown immediately when the type is selected. */
  nativeFields: CoreField[];
  /** Offered in the "+" optional-field menu (core fields not already native). */
  optionalCoreFields: CoreField[];
  /** Offered in the "+" menu, stored in `extra`. */
  optionalExtraFields: ExtraFieldDef[];
  /** Whether the scheduler treats it as a fixed-time event vs. a schedulable todo. */
  scheduling: "fixed" | "flexible";
}

const locationField: ExtraFieldDef = { key: "location", label: "Location", input: "text" };

export const ITEM_TYPES: ItemTypeDef[] = [
  {
    type: "event",
    label: "Event",
    nativeFields: ["startAt", "endAt"],
    optionalCoreFields: ["guests", "notBeforeAt"],
    optionalExtraFields: [locationField],
    scheduling: "fixed",
  },
  {
    type: "todo",
    label: "Todo",
    nativeFields: ["dueAt", "estimatedMinutes"],
    optionalCoreFields: ["notBeforeAt", "guests", "startAt", "endAt"],
    optionalExtraFields: [locationField],
    scheduling: "flexible",
  },
];

export function getItemType(type: string): ItemTypeDef | undefined {
  return ITEM_TYPES.find((t) => t.type === type);
}

/** Fixed-time item: has explicit start+end and is shown as-is on the agenda. */
export function isFixed(type: string): boolean {
  return getItemType(type)?.scheduling === "fixed";
}
