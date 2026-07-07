/**
 * LLM soft pass: groups todos into sensible, labelled blocks and spreads load so
 * the agenda feels doable. Hard constraints are inputs it must stay inside —
 * they are enforced by deterministic code (deterministic.ts) and re-checked by
 * validate.ts, never trusted to the model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { DeterministicResult } from "./deterministic.js";
import { estimateOf, type PlannedBlock, type SchedulerInput } from "./types.js";

const MODEL = "claude-opus-4-8";

const planSchema = z.object({
  blocks: z.array(
    z.object({
      date: z.string().describe("YYYY-MM-DD, must be one of the given days"),
      startMinutes: z.number().int().describe("Minutes since midnight, inside a free slot"),
      endMinutes: z.number().int(),
      label: z
        .string()
        .describe('Short human label for the block, e.g. "Admin – todos" or "Paperwork"'),
      itemIds: z.array(z.string()).describe("Ids of the todos done in this block"),
    }),
  ),
});

export type LlmPlan = z.infer<typeof planSchema>;

const SYSTEM_PROMPT = `You are the scheduling assistant of a small firm's internal agenda platform.

You receive a set of todos with hard constraints (earliest start, due date, dependencies, estimated minutes) and the free time slots per day that remain after fixed events. Your job is the SOFT layer of scheduling:

- Group related todos into blocks with a short, sensible label (e.g. "Admin – todos", "Paperwork", "Client X prep"). Use the todo titles and types to decide what belongs together.
- Spread work out over the available days instead of cramming everything into the first day. The agenda should look doable, not overwhelming. Prefer at most ~2-3 blocks per day and leave breathing room where deadlines allow.
- Every block must fit entirely inside one of the given free slots for that day.
- A block's duration must be at least the sum of its todos' estimated minutes.
- Every todo must be placed in exactly one block.
- Within a block, the itemIds order is the execution order: the first todo runs at the block start, each next one after the previous finishes (using their estimated minutes).
- A todo must not start before its "earliest" timestamp and must end before its "due" timestamp (when given).
- If todo A lists todo B in dependsOn, A's block must start after B's block ends.

All hard constraints are re-checked by the platform. If your plan violates any, you will be asked to correct it.`;

interface Attempt {
  plan: LlmPlan;
  violations: string[];
}

export async function llmPlanPass(
  input: SchedulerInput,
  det: DeterministicResult,
  previous: Attempt[],
): Promise<PlannedBlock[]> {
  const client = new Anthropic();

  const payload = {
    days: input.windows.map((w) => ({
      date: w.date,
      freeSlots: det.freeSlots
        .filter((s) => s.date === w.date)
        .map((s) => ({ startMinutes: s.startMinutes, endMinutes: s.endMinutes })),
    })),
    todos: det.todos.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      estimatedMinutes: estimateOf(t),
      earliest: det.bounds.get(t.id)?.earliest.toISOString() ?? null,
      due: t.dueAt?.toISOString() ?? null,
      dependsOn: t.dependsOn,
    })),
    timezone: input.timezone,
    now: input.now.toISOString(),
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Plan the following todos into blocks.\n\n${JSON.stringify(payload, null, 2)}`,
    },
  ];
  for (const attempt of previous) {
    messages.push(
      { role: "assistant", content: JSON.stringify(attempt.plan) },
      {
        role: "user",
        content: `That plan violates hard constraints. Fix ALL of the following and return the corrected full plan:\n- ${attempt.violations.join("\n- ")}`,
      },
    );
  }

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages,
    output_config: { format: zodOutputFormat(planSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("LLM returned no parseable plan");
  return parsed.blocks.map((b) => ({ ...b, kind: "todo_batch" as const }));
}

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
