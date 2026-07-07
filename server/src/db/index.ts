import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

let db: Db | undefined;

/** Works both from src/ (tsx dev) and dist/ (built) layouts. */
function migrationsFolder(): string {
  const candidates = [
    new URL("./migrations", import.meta.url),
    new URL("../../src/db/migrations", import.meta.url),
  ];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    if (existsSync(p)) return p;
  }
  throw new Error("migrations folder not found");
}

/**
 * DATABASE_URL set  -> real Postgres via node-postgres (docker-compose / prod).
 * DATABASE_URL unset -> embedded PGlite at .pglite-data/ (zero-setup local dev).
 * Same schema and migrations in both cases.
 */
export async function initDb(): Promise<Db> {
  if (db) return db;
  const folder = migrationsFolder();

  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
    const d = drizzle(pool, { schema });
    await migrate(d, { migrationsFolder: folder });
    db = d;
  } else {
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dataDir = process.env.PGLITE_DATA_DIR ?? ".pglite-data";
    const d = drizzle(dataDir, { schema });
    await migrate(d, { migrationsFolder: folder });
    db = d;
  }
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("db not initialised — call initDb() first");
  return db;
}

export { schema };
