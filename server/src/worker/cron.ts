/**
 * Scheduled worker: re-runs the AI planner for every user on the configured
 * cadence (settings.recalc_cron). Re-armed whenever the setting changes.
 */
import { Cron } from "croner";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { recalcForUser } from "../scheduler/run.js";
import { getSettings } from "../settings.js";

let job: Cron | undefined;

export async function recalcAllUsers(): Promise<void> {
  const db = getDb();
  const all = await db.select().from(users);
  for (const user of all) {
    try {
      const result = await recalcForUser(user.id);
      console.log(
        `[scheduler] ${user.name}: ${result.blocks.length} blocks` +
          (result.usedLlm ? ` (AI, ${result.llmAttempts} attempt(s))` : " (baseline)") +
          (result.warnings.length ? ` — ${result.warnings.join("; ")}` : ""),
      );
    } catch (err) {
      console.error(`[scheduler] failed for ${user.name}:`, err);
    }
  }
}

/** (Re)arm the cron job from current settings. Call at boot and after settings changes. */
export async function armCron(): Promise<void> {
  const settings = await getSettings();
  job?.stop();
  job = new Cron(settings.recalcCron, { timezone: settings.timezone }, () => {
    void recalcAllUsers();
  });
  console.log(
    `[scheduler] cron armed: "${settings.recalcCron}" (${settings.timezone}), next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
}
