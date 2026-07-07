import type { Db } from "./index.js";
import { settings, users, workWindowDefaults } from "./schema.js";

const FIRM_MEMBERS = [
  { name: "Bram", color: "#4f6d7a" },
  { name: "Anna", color: "#b56548" },
  { name: "Tomas", color: "#5a7d4a" },
];

export const DEFAULT_SETTINGS: Record<string, string> = {
  planning_horizon_days: "14",
  recalc_cron: "0 * * * *", // hourly
  timezone: "Europe/Brussels",
};

/** Idempotent: only seeds when the users table is empty. */
export async function seedIfEmpty(db: Db): Promise<void> {
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0) return;

  const inserted = await db.insert(users).values(FIRM_MEMBERS).returning();

  // Weekday default work windows: Mon–Fri 09:00–17:30
  const defaults = inserted.flatMap((u) =>
    [1, 2, 3, 4, 5].map((weekday) => ({
      userId: u.id,
      weekday,
      startMinutes: 9 * 60,
      endMinutes: 17 * 60 + 30,
    })),
  );
  await db.insert(workWindowDefaults).values(defaults);

  await db
    .insert(settings)
    .values(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value })));

  console.log(`Seeded ${inserted.length} users with default work windows and settings.`);
}

// Allow running standalone: `npm run db:seed -w server`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const { initDb } = await import("./index.js");
  const db = await initDb();
  await seedIfEmpty(db);
  process.exit(0);
}
