import { config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { heuristicExtract } from "./heuristic.js";
import type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

export type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

/**
 * Runs the same deterministic parser the pipeline falls back to, so the repo
 * boots, the demo works and the evals score with no API key in sight.
 */
class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly metered = false;
  readonly maxOutputTokens = 0;

  async estimateInputTokens(request: ExtractRequest): Promise<number> {
    // Rough enough for a provider that costs nothing; the real one counts.
    return Math.ceil(request.text.length / 4);
  }

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    return {
      lead: heuristicExtract(request.text, {
        referenceDate: request.referenceDate,
        contactHint: request.contactHint,
      }),
      source: "heuristic",
      model: null,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  cached ??=
    config.llmProvider === "anthropic" ? new AnthropicProvider() : new MockProvider();
  return cached;
}
