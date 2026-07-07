import { and, eq, gte, lte } from "drizzle-orm";
import type { WorkWindowDto } from "@vdv/shared";
import { getDb } from "./db/index.js";
import { workWindowDefaults, workWindows } from "./db/schema.js";

export function* dateRange(fromDate: string, toDate: string): Generator<string> {
  const d = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Resolved window per day: per-date override wins over the weekly default. */
export async function resolveWorkWindows(
  userId: string,
  fromDate: string,
  toDate: string,
): Promise<WorkWindowDto[]> {
  const db = getDb();
  const [overrides, defaults] = await Promise.all([
    db
      .select()
      .from(workWindows)
      .where(
        and(eq(workWindows.userId, userId), gte(workWindows.date, fromDate), lte(workWindows.date, toDate)),
      ),
    db.select().from(workWindowDefaults).where(eq(workWindowDefaults.userId, userId)),
  ]);

  const byDate = new Map(overrides.map((o) => [o.date, o]));
  const byWeekday = new Map(defaults.map((d) => [d.weekday, d]));

  const result: WorkWindowDto[] = [];
  for (const date of dateRange(fromDate, toDate)) {
    const override = byDate.get(date);
    if (override) {
      result.push({
        date,
        startMinutes: override.startMinutes,
        endMinutes: override.endMinutes,
        isDefault: false,
      });
      continue;
    }
    const def = byWeekday.get(weekdayOf(date));
    if (def) {
      result.push({
        date,
        startMinutes: def.startMinutes,
        endMinutes: def.endMinutes,
        isDefault: true,
      });
    }
    // No default for this weekday (e.g. weekend) -> no working time that day.
  }
  return result;
}

export async function setWorkWindow(
  userId: string,
  date: string,
  startMinutes: number,
  endMinutes: number,
): Promise<void> {
  const db = getDb();
  await db
    .delete(workWindows)
    .where(and(eq(workWindows.userId, userId), eq(workWindows.date, date)));
  await db.insert(workWindows).values({ userId, date, startMinutes, endMinutes });
}
