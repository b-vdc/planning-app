import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { z, ZodError } from "zod";
import { ITEM_TYPES, type AgendaDto } from "@vdv/shared";
import { getDb } from "../db/index.js";
import { scheduleBlockItems, scheduleBlocks, users, workWindowDefaults } from "../db/schema.js";
import {
  addDependency,
  createItem,
  createItemSchema,
  getItem,
  HttpError,
  markDone,
  searchItems,
  searchItemsSchema,
  updateItem,
  updateItemSchema,
} from "../items/tools.js";
import { addDays, recalcForUser } from "../scheduler/run.js";
import { toWallClock } from "../scheduler/time.js";
import { getSettings, putSetting } from "../settings.js";
import { armCron } from "../worker/cron.js";
import { resolveWorkWindows, setWorkWindow } from "../workWindows.js";

/** No auth yet (user's choice): the SPA sends the picked user as x-user-id. */
function requireUserId(req: FastifyRequest): string {
  const id = req.headers["x-user-id"];
  if (typeof id !== "string" || !id) throw new HttpError(400, "x-user-id header required");
  return id;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: "Validation failed", issues: err.issues });
    app.log.error(err);
    return reply.status(500).send({ error: "Internal server error" });
  });

  // ---- users & item types ----
  app.get("/api/users", async () => {
    const db = getDb();
    return db.select().from(users);
  });
  app.get("/api/item-types", async () => ITEM_TYPES);

  // ---- items ----
  app.get("/api/items", async (req) => {
    const q = searchItemsSchema.parse(req.query ?? {});
    return searchItems(q);
  });
  app.get("/api/items/:id", async (req) => {
    const { id } = req.params as { id: string };
    const item = await getItem(id);
    if (!item) throw new HttpError(404, "Item not found");
    return item;
  });
  app.post("/api/items", async (req, reply) => {
    const userId = requireUserId(req);
    const item = await createItem(createItemSchema.parse(req.body), userId);
    return reply.status(201).send(item);
  });
  app.patch("/api/items/:id", async (req) => {
    const { id } = req.params as { id: string };
    return updateItem(id, updateItemSchema.parse(req.body));
  });
  app.post("/api/items/:id/done", async (req) => {
    const { id } = req.params as { id: string };
    return markDone(id);
  });
  app.post("/api/items/:id/dependencies", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dependsOnId } = z.object({ dependsOnId: z.string() }).parse(req.body);
    await addDependency(id, dependsOnId);
    return reply.status(204).send();
  });

  // ---- work windows ----
  const rangeSchema = z.object({ from: z.string(), to: z.string() });
  app.get("/api/work-windows", async (req) => {
    const userId = requireUserId(req);
    const { from, to } = rangeSchema.parse(req.query);
    return resolveWorkWindows(userId, from, to);
  });
  app.put("/api/work-windows", async (req, reply) => {
    const userId = requireUserId(req);
    const body = z
      .object({
        date: z.string(),
        startMinutes: z.number().int().min(0).max(1440),
        endMinutes: z.number().int().min(0).max(1440),
      })
      .refine((b) => b.endMinutes > b.startMinutes, "end must be after start")
      .parse(req.body);
    await setWorkWindow(userId, body.date, body.startMinutes, body.endMinutes);
    return reply.status(204).send();
  });
  app.get("/api/work-window-defaults", async (req) => {
    const userId = requireUserId(req);
    const db = getDb();
    return db.select().from(workWindowDefaults).where(eq(workWindowDefaults.userId, userId));
  });

  // ---- agenda ----
  app.get("/api/agenda", async (req) => {
    const userId = requireUserId(req);
    const settings = await getSettings();
    const today = toWallClock(new Date(), settings.timezone).date;
    const q = z
      .object({ from: z.string().default(today), to: z.string().optional() })
      .parse(req.query ?? {});
    const to = q.to ?? addDays(q.from, settings.planningHorizonDays - 1);

    const db = getDb();
    const blocks = await db
      .select()
      .from(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.userId, userId),
          gte(scheduleBlocks.date, q.from),
          lte(scheduleBlocks.date, to),
        ),
      );
    const blockIds = blocks.map((b) => b.id);
    const links = blockIds.length
      ? await db
          .select()
          .from(scheduleBlockItems)
          .where(inArray(scheduleBlockItems.blockId, blockIds))
      : [];

    const itemIds = [...new Set(links.map((l) => l.itemId))];
    const itemDtos = await Promise.all(itemIds.map((id) => getItem(id)));
    const itemsById = Object.fromEntries(
      itemDtos.filter((i) => i !== null).map((i) => [i!.id, i!]),
    );

    const agenda: AgendaDto = {
      blocks: blocks
        .map((b) => ({
          id: b.id,
          userId: b.userId,
          date: b.date,
          startMinutes: b.startMinutes,
          endMinutes: b.endMinutes,
          label: b.label,
          kind: b.kind,
          itemIds: links.filter((l) => l.blockId === b.id).map((l) => l.itemId),
        }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMinutes - b.startMinutes)),
      items: itemsById,
      workWindows: await resolveWorkWindows(userId, q.from, to),
    };
    return agenda;
  });

  app.post("/api/agenda/recalculate", async (req) => {
    const userId = requireUserId(req);
    return recalcForUser(userId);
  });

  // ---- settings ----
  app.get("/api/settings", async () => getSettings());
  app.put("/api/settings", async (req) => {
    const body = z
      .object({
        planningHorizonDays: z.number().int().min(1).max(90).optional(),
        recalcCron: z.string().optional(),
        timezone: z.string().optional(),
      })
      .parse(req.body);
    if (body.planningHorizonDays !== undefined)
      await putSetting("planning_horizon_days", String(body.planningHorizonDays));
    if (body.recalcCron !== undefined) await putSetting("recalc_cron", body.recalcCron);
    if (body.timezone !== undefined) await putSetting("timezone", body.timezone);
    if (body.recalcCron !== undefined || body.timezone !== undefined) await armCron();
    return getSettings();
  });
}
