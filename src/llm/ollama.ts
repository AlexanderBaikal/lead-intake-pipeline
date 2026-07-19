import { z } from "zod";

import { config } from "../config.js";
import { log } from "../logger.js";
import { ExtractedLead } from "../schema.js";
import { heuristicExtract } from "./heuristic.js";
import { SYSTEM, userPrompt } from "./prompt.js";
import type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

/**
 * A local model on a laptop answers in tens of seconds, not the two or three a
 * hosted one takes. The cap is here so a wedged server surfaces as a failed job
 * instead of a worker that never returns.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The same cap the hosted provider uses, passed as `num_predict`. Nothing
 * prices against it here, but a runaway generation on a local model costs
 * minutes, which is its own kind of bill.
 */
const MAX_OUTPUT_TOKENS = 1_024;

function stripKeys(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => stripKeys(item, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !keys.includes(key))
        .map(([key, nested]) => [key, stripKeys(nested, keys)]),
    );
  }
  return value;
}

/**
 * Ollama constrains generation with a JSON Schema handed to `format`, so the
 * schema comes from the same zod model the CRM record is validated against —
 * there is no second copy to drift.
 *
 * Two keys are removed on the way out. `$schema` describes the document rather
 * than the shape. `pattern` is removed because Ollama compiles the schema into
 * a sampling grammar and the regex on `requested_date` takes the model runner
 * down with it — an HTTP 500 reading "model runner has unexpectedly stopped",
 * not a validation error. Dropping it costs nothing that matters: the grammar
 * was never the thing enforcing the date format. `extract` parses the answer
 * back through `ExtractedLead`, so a date the sampler was free to invent is
 * still rejected, and the lead falls back to the deterministic parser exactly
 * as it does for a truncated answer.
 */
const FORMAT = stripKeys(z.toJSONSchema(ExtractedLead), ["$schema", "pattern"]);

/**
 * Qwen3 writes its reasoning inline unless told not to. Earlier Qwen releases
 * do not understand the flag, so sending it to them just puts a stray token at
 * the top of the prompt.
 */
const isQwen3 = (model: string): boolean => /^qwen3/i.test(model);

interface GenerateResponse {
  response?: string;
  /** Ollama reports bad input in the body, with a 200 on the envelope. */
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";

  /**
   * It runs on your own machine, so there is nothing to bill and the budget
   * gate has nothing to gate. The ledger and the ceiling only mean anything
   * for a metered provider.
   */
  readonly metered = false;

  readonly model = config.ollamaModel;
  readonly maxOutputTokens = MAX_OUTPUT_TOKENS;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(fetchImpl: typeof fetch = fetch, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async estimateInputTokens(request: ExtractRequest): Promise<number> {
    // Never reached: the pipeline only prices metered providers. Rough is the
    // honest answer for a provider that has no price to be wrong about.
    return Math.ceil((SYSTEM.length + request.text.length) / 4);
  }

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const body = await this.generate(request);

    const usage = {
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
    };

    // Ollama's grammar constrains the shape but not the contents: the date
    // pattern and the integer bounds are enforced here, not by the sampler.
    // An answer that misses them is unusable in the same way a truncated one
    // is, and gets the same treatment as the hosted provider gives a refusal.
    const parsed = this.parse(body.response ?? "");
    if (!parsed.success) {
      log.warn("ollama returned no usable object, using deterministic parser", {
        model: this.model,
        reason: parsed.reason,
      });
      return {
        lead: heuristicExtract(request.text, {
          referenceDate: request.referenceDate,
          contactHint: request.contactHint,
        }),
        source: "heuristic",
        model: this.model,
        ...usage,
      };
    }

    return { lead: parsed.lead, source: "model", model: this.model, ...usage };
  }

  /**
   * Transport failures throw rather than degrade. A server that is down is an
   * outage, and swallowing it would tag every lead `heuristic` while the
   * pipeline looked healthy — the same silent-success this repo refuses
   * elsewhere. Unusable output is a different thing and is handled by caller.
   */
  private async generate(request: ExtractRequest): Promise<GenerateResponse> {
    const prompt = [SYSTEM, "", userPrompt(request)].join("\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${config.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: isQwen3(this.model) ? `/no_think\n\n${prompt}` : prompt,
          format: FORMAT,
          stream: false,
          options: { temperature: 0, num_predict: MAX_OUTPUT_TOKENS },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`ollama HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const body = (await response.json()) as GenerateResponse;
      if (body.error) throw new Error(`ollama: ${body.error}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(
    raw: string,
  ): { success: true; lead: ExtractedLead } | { success: false; reason: string } {
    // Strip reasoning blocks even when /no_think was sent; the flag is a
    // request, not a guarantee.
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!cleaned) return { success: false, reason: "empty response" };

    let json: unknown;
    try {
      json = JSON.parse(cleaned);
    } catch {
      return { success: false, reason: "response was not JSON" };
    }

    const result = ExtractedLead.safeParse(json);
    return result.success
      ? { success: true, lead: result.data }
      : { success: false, reason: z.prettifyError(result.error).replace(/\n+/g, "; ") };
  }
}
