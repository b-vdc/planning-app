/**
 * Orchestrates one scheduler run for one user:
 * deterministic pass -> LLM soft pass -> validate -> feedback loop (max 3)
 * -> fall back to the deterministic baseline if the LLM can't produce a valid
 * plan (or no API key is configured). An invalid agenda is never persisted.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { scheduleBlockItems, scheduleBlocks } from "../db/schema.js";
import { itemsForUser } from "../items/tools.js";
import { getSettings } from "../settings.js";
import { resolveWorkWindows } from "../workWindows.js";
import { deterministicPlan } from "./deterministic.js";
import { llmAvailable, llmPlanPass } from "./llm.js";
import { toWallClock } from "./time.js";
import type { PlannedBlock, SchedulerInput, SchedulerItem } from "./types.js";
import { validatePlan } from "./validate.js";

const MAX_LLM_ATTEMPTS = 3;

export interface RecalcResult {
  blocks: PlannedBlock[];
  usedLlm: boolean;
  llmAttempts: number;
  warnings: string[];
}

export async function recalcForUser(userId: string): Promise<RecalcResult> {
  const settings = await getSettings();
  const now = new Date();
  const today = toWallClock(now, settings.timezone).date;
  const lastDay = addDays(today, settings.planningHorizonDays - 1);

  const windows = await resolveWorkWindows(userId, today, lastDay);
  const dtos = await itemsForUser(userId);
  const items: SchedulerItem[] = dtos.map((d) => ({
    id: d.id,
    type: d.type,
    title: d.title,
    status: d.status,
    dueAt: d.dueAt ? new Date(d.dueAt) : null,
    startAt: d.startAt ? new Date(d.startAt) : null,
    endAt: d.endAt ? new Date(d.endAt) : null,
    notBeforeAt: d.notBeforeAt ? new Date(d.notBeforeAt) : null,
    estimatedMinutes: d.estimatedMinutes,
    dependsOn: d.dependsOn,
  }));

  const input: SchedulerInput = { now, timezone: settings.timezone, windows, items };
  const det = deterministicPlan(input);
  const warnings = [...det.warnings];
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const requiredItemIds = det.baselineTodoBlocks.flatMap((b) => b.itemIds);

  let todoBlocks = det.baselineTodoBlocks;
  let usedLlm = false;
  let llmAttempts = 0;

  if (llmAvailable() && det.todos.length > 0) {
    const previous: { plan: { blocks: PlannedBlock[] }; violations: string[] }[] = [];
    for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
      llmAttempts = attempt;
      try {
        const candidate = await llmPlanPass(input, det, previous);
        const violations = validatePlan({
          plan: candidate,
          eventBlocks: det.eventBlocks,
          windows,
          items: itemMap,
          requiredItemIds,
          now,
          timezone: settings.timezone,
        });
        if (violations.length === 0) {
          todoBlocks = candidate;
          usedLlm = true;
          break;
        }
        previous.push({ plan: { blocks: candidate }, violations });
        if (attempt === MAX_LLM_ATTEMPTS) {
          warnings.push(
            `AI plan still invalid after ${MAX_LLM_ATTEMPTS} attempts — using the deterministic baseline`,
          );
        }
      } catch (err) {
        warnings.push(`AI planning failed (${(err as Error).message}) — using the deterministic baseline`);
        break;
      }
    }
  } else if (!llmAvailable() && det.todos.length > 0) {
    warnings.push("ANTHROPIC_API_KEY not set — using the deterministic baseline plan");
  }

  const finalBlocks = [...det.eventBlocks, ...todoBlocks];
  await persistBlocks(userId, today, finalBlocks);
  return { blocks: finalBlocks, usedLlm, llmAttempts, warnings };
}

/** Transactionally replace the user's blocks from `fromDate` forward. */
async function persistBlocks(userId: string, fromDate: string, blocks: PlannedBlock[]): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const old = await tx
      .select({ id: scheduleBlocks.id })
      .from(scheduleBlocks)
      .where(and(eq(scheduleBlocks.userId, userId), gte(scheduleBlocks.date, fromDate)));
    if (old.length > 0) {
      const oldIds = old.map((o) => o.id);
      await tx.delete(scheduleBlockItems).where(inArray(scheduleBlockItems.blockId, oldIds));
      await tx.delete(scheduleBlocks).where(inArray(scheduleBlocks.id, oldIds));
    }
    for (const block of blocks) {
      const [row] = await tx
        .insert(scheduleBlocks)
        .values({
          userId,
          date: block.date,
          startMinutes: block.startMinutes,
          endMinutes: block.endMinutes,
          label: block.label,
          kind: block.kind,
        })
        .returning();
      if (block.itemIds.length > 0) {
        await tx
          .insert(scheduleBlockItems)
          .values(block.itemIds.map((itemId) => ({ blockId: row.id, itemId })));
      }
    }
  });
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
