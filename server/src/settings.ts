import { eq } from "drizzle-orm";
import type { SettingsDto } from "@vdv/shared";
import { getDb } from "./db/index.js";
import { settings } from "./db/schema.js";
import { DEFAULT_SETTINGS } from "./db/seed.js";

export async function getSettings(): Promise<SettingsDto> {
  const db = getDb();
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    planningHorizonDays: Number(
      map.get("planning_horizon_days") ?? DEFAULT_SETTINGS.planning_horizon_days,
    ),
    recalcCron: map.get("recalc_cron") ?? DEFAULT_SETTINGS.recalc_cron,
    timezone: map.get("timezone") ?? DEFAULT_SETTINGS.timezone,
  };
}

export async function putSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}
