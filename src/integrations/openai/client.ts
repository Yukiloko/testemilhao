import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { db, type Db } from "@/db/client";
import { aiCalls } from "@/db/schema";
import { assertWithinBudget } from "@/features/safety/budget";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";

export type ModelTier = "main" | "fast";

export type CompletionRequest = { model: string; system: string; user: string; schemaName: string; jsonSchema: Record<string, unknown> };
export type CompletionResult = { text: string; inputTokens: number; outputTokens: number };

/** The transport is a plain function so tests can substitute a scripted model. */
export type Completer = (req: CompletionRequest) => Promise<CompletionResult>;

let client: OpenAI | undefined;

export const openAiCompleter: Completer = async (req) => {
  client ??= new OpenAI({ apiKey: env().OPENAI_API_KEY, maxRetries: 2, timeout: 60_000 });
  const response = await client.responses.create({
    model: req.model,
    input: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    text: { format: { type: "json_schema", name: req.schemaName, schema: req.jsonSchema, strict: true } },
  });
  return { text: response.output_text, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
};

let activeCompleter: Completer = openAiCompleter;

export function setCompleter(next: Completer | undefined): void {
  activeCompleter = next ?? openAiCompleter;
}

export function modelFor(tier: ModelTier): { model: string; inputPer1M: number; outputPer1M: number } {
  const e = env();
  return tier === "main"
    ? { model: e.OPENAI_MODEL, inputPer1M: e.OPENAI_MODEL_INPUT_USD_PER_1M, outputPer1M: e.OPENAI_MODEL_OUTPUT_USD_PER_1M }
    : { model: e.OPENAI_MODEL_FAST, inputPer1M: e.OPENAI_MODEL_FAST_INPUT_USD_PER_1M, outputPer1M: e.OPENAI_MODEL_FAST_OUTPUT_USD_PER_1M };
}

/** Strict structured outputs need every property required and no extra properties, recursively. */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== "$schema") out[k] = walk(v);
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.required = Object.keys(out.properties);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export class AiOutputError extends Error {}

/**
 * The only way the system talks to OpenAI: budget check first, then the call, then one
 * `ai_calls` row with tokens and estimated cost whether the call succeeded or not.
 */
export async function callStructured<T extends z.ZodType>(
  input: { purpose: string; tier: ModelTier; leadId?: number | null; system: string; user: string; schema: T; schemaName: string },
  now: () => Date = () => new Date(),
  d: Db = db(),
): Promise<z.infer<T>> {
  const { model, inputPer1M, outputPer1M } = modelFor(input.tier);
  assertWithinBudget(env().OPENAI_MONTHLY_BUDGET_USD, now(), d);
  const started = Date.now();
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const result = await activeCompleter({ model, system: input.system, user: input.user, schemaName: input.schemaName, jsonSchema: toStrictJsonSchema(input.schema) });
    usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    const parsed = input.schema.safeParse(JSON.parse(result.text));
    if (!parsed.success) throw new AiOutputError(`invalid ${input.schemaName} output: ${parsed.error.message}`);
    record(true, null);
    return parsed.data;
  } catch (error) {
    record(false, error instanceof Error ? error.message : String(error));
    log.error("openai call failed", { purpose: input.purpose, model, error });
    throw error;
  }

  function record(ok: boolean, error: string | null) {
    const costUsd = (usage.inputTokens * inputPer1M + usage.outputTokens * outputPer1M) / 1_000_000;
    d.insert(aiCalls)
      .values({ purpose: input.purpose, model, leadId: input.leadId ?? null, ...usage, costUsd, latencyMs: Date.now() - started, ok, error })
      .run();
  }
}
