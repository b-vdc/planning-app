/**
 * Shared item-tools module.
 *
 * Single source of truth for item operations, consumed by:
 *  1. the REST routes (phase 1),
 *  2. the scheduler's data loading,
 *  3. the chat tool-use loop (phase 2) — each function's Zod schema doubles as
 *     the `betaZodTool` input schema, and as an MCP tool schema later if wanted.
 */
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getItemType, type ItemDto } from "@vdv/shared";
import { getDb } from "../db/index.js";
import { itemDependencies, itemGuests, items } from "../db/schema.js";

const isoDate = z.string().datetime({ offset: true });

export const searchItemsSchema = z.object({
  query: z.string().optional().describe("Case-insensitive match on the item title"),
  type: z.string().optional(),
  status: z.enum(["open", "done"]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const createItemSchema = z.object({
  type: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  dueAt: isoDate.nullish(),
  startAt: isoDate.nullish(),
  endAt: isoDate.nullish(),
  notBeforeAt: isoDate.nullish(),
  estimatedMinutes: z.number().int().positive().nullish(),
  extra: z.record(z.string(), z.unknown()).default({}),
  guests: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]).describe("Item ids this item can only start after"),
});

export const updateItemSchema = createItemSchema.partial().extend({
  status: z.enum(["open", "done"]).optional(),
});

type ItemRow = typeof items.$inferSelect;

async function relationsFor(itemIds: string[]) {
  const db = getDb();
  if (itemIds.length === 0) return { deps: [], guests: [] };
  const [deps, guests] = await Promise.all([
    db.select().from(itemDependencies).where(inArray(itemDependencies.itemId, itemIds)),
    db.select().from(itemGuests).where(inArray(itemGuests.itemId, itemIds)),
  ]);
  return { deps, guests };
}

function toDto(
  row: ItemRow,
  deps: { itemId: string; dependsOnId: string }[],
  guests: { itemId: string; userId: string }[],
): ItemDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status,
    doneAt: row.doneAt?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
    startAt: row.startAt?.toISOString() ?? null,
    endAt: row.endAt?.toISOString() ?? null,
    notBeforeAt: row.notBeforeAt?.toISOString() ?? null,
    estimatedMinutes: row.estimatedMinutes,
    extra: (row.extra ?? {}) as Record<string, unknown>,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    dependsOn: deps.filter((d) => d.itemId === row.id).map((d) => d.dependsOnId),
    guests: guests.filter((g) => g.itemId === row.id).map((g) => g.userId),
  };
}

async function toDtos(rows: ItemRow[]): Promise<ItemDto[]> {
  const { deps, guests } = await relationsFor(rows.map((r) => r.id));
  return rows.map((r) => toDto(r, deps, guests));
}

export async function searchItems(input: z.input<typeof searchItemsSchema>): Promise<ItemDto[]> {
  const { query, type, status, limit } = searchItemsSchema.parse(input);
  const db = getDb();
  const conditions = [];
  if (query) conditions.push(ilike(items.title, `%${query}%`));
  if (type) conditions.push(eq(items.type, type));
  if (status) conditions.push(eq(items.status, status));
  const rows = await db
    .select()
    .from(items)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${items.createdAt} desc`)
    .limit(limit);
  return toDtos(rows);
}

export async function getItem(id: string): Promise<ItemDto | null> {
  const db = getDb();
  const rows = await db.select().from(items).where(eq(items.id, id)).limit(1);
  if (rows.length === 0) return null;
  return (await toDtos(rows))[0];
}

function validateTypeFields(type: string, data: { startAt?: string | null; endAt?: string | null }) {
  const def = getItemType(type);
  if (!def) throw new HttpError(400, `Unknown item type: ${type}`);
  if (def.scheduling === "fixed" && (!data.startAt || !data.endAt)) {
    throw new HttpError(400, `${def.label} items need a start date and an end date`);
  }
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function createItem(
  input: z.input<typeof createItemSchema>,
  createdBy: string,
): Promise<ItemDto> {
  const data = createItemSchema.parse(input);
  validateTypeFields(data.type, data);
  const db = getDb();

  const [row] = await db
    .insert(items)
    .values({
      type: data.type,
      title: data.title,
      description: data.description,
      dueAt: data.dueAt ? new Date(data.dueAt) : null,
      startAt: data.startAt ? new Date(data.startAt) : null,
      endAt: data.endAt ? new Date(data.endAt) : null,
      notBeforeAt: data.notBeforeAt ? new Date(data.notBeforeAt) : null,
      estimatedMinutes: data.estimatedMinutes ?? null,
      extra: data.extra,
      createdBy,
    })
    .returning();

  for (const depId of data.dependsOn) await addDependency(row.id, depId);
  if (data.guests.length > 0) {
    await db.insert(itemGuests).values(data.guests.map((userId) => ({ itemId: row.id, userId })));
  }
  return (await getItem(row.id))!;
}

export async function updateItem(
  id: string,
  input: z.input<typeof updateItemSchema>,
): Promise<ItemDto> {
  const patch = updateItemSchema.parse(input);
  const db = getDb();
  const existing = await getItem(id);
  if (!existing) throw new HttpError(404, "Item not found");

  const type = patch.type ?? existing.type;
  validateTypeFields(type, {
    startAt: patch.startAt !== undefined ? patch.startAt : existing.startAt,
    endAt: patch.endAt !== undefined ? patch.endAt : existing.endAt,
  });

  const values: Partial<typeof items.$inferInsert> = { updatedAt: new Date() };
  if (patch.type !== undefined) values.type = patch.type;
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.dueAt !== undefined) values.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
  if (patch.startAt !== undefined) values.startAt = patch.startAt ? new Date(patch.startAt) : null;
  if (patch.endAt !== undefined) values.endAt = patch.endAt ? new Date(patch.endAt) : null;
  if (patch.notBeforeAt !== undefined)
    values.notBeforeAt = patch.notBeforeAt ? new Date(patch.notBeforeAt) : null;
  if (patch.estimatedMinutes !== undefined) values.estimatedMinutes = patch.estimatedMinutes ?? null;
  if (patch.extra !== undefined) values.extra = patch.extra;
  if (patch.status !== undefined) {
    values.status = patch.status;
    values.doneAt = patch.status === "done" ? new Date() : null;
  }

  await db.update(items).set(values).where(eq(items.id, id));

  if (patch.dependsOn !== undefined) {
    await db.delete(itemDependencies).where(eq(itemDependencies.itemId, id));
    for (const depId of patch.dependsOn) await addDependency(id, depId);
  }
  if (patch.guests !== undefined) {
    await db.delete(itemGuests).where(eq(itemGuests.itemId, id));
    if (patch.guests.length > 0) {
      await db.insert(itemGuests).values(patch.guests.map((userId) => ({ itemId: id, userId })));
    }
  }
  return (await getItem(id))!;
}

export async function markDone(id: string): Promise<ItemDto> {
  return updateItem(id, { status: "done" });
}

/** Adds itemId -> dependsOnId, rejecting self-references and cycles. */
export async function addDependency(itemId: string, dependsOnId: string): Promise<void> {
  if (itemId === dependsOnId) throw new HttpError(400, "An item cannot depend on itself");
  const db = getDb();

  const dep = await db.select().from(items).where(eq(items.id, dependsOnId)).limit(1);
  if (dep.length === 0) throw new HttpError(400, `Dependency target not found: ${dependsOnId}`);

  // Cycle check: can we reach itemId starting from dependsOnId?
  const all = await db.select().from(itemDependencies);
  const edges = new Map<string, string[]>();
  for (const e of all) {
    (edges.get(e.itemId) ?? edges.set(e.itemId, []).get(e.itemId)!).push(e.dependsOnId);
  }
  const stack = [dependsOnId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === itemId) {
      throw new HttpError(400, "This dependency would create a cycle");
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(edges.get(cur) ?? []));
  }

  await db
    .insert(itemDependencies)
    .values({ itemId, dependsOnId })
    .onConflictDoNothing();
}

/** All open items relevant to a user's agenda (creator or guest), plus their dependency targets. */
export async function itemsForUser(userId: string): Promise<ItemDto[]> {
  const db = getDb();
  const guestRows = await db.select().from(itemGuests).where(eq(itemGuests.userId, userId));
  const guestItemIds = guestRows.map((g) => g.itemId);

  const rows = await db
    .select()
    .from(items)
    .where(
      guestItemIds.length > 0
        ? sql`${items.createdBy} = ${userId} or ${items.id} in ${guestItemIds}`
        : eq(items.createdBy, userId),
    );

  const dtos = await toDtos(rows);

  // Dependencies may point at items owned by others; the scheduler needs their status.
  const have = new Set(dtos.map((d) => d.id));
  const missingDeps = [...new Set(dtos.flatMap((d) => d.dependsOn))].filter((id) => !have.has(id));
  if (missingDeps.length > 0) {
    const depRows = await db.select().from(items).where(inArray(items.id, missingDeps));
    dtos.push(...(await toDtos(depRows)));
  }
  return dtos;
}
