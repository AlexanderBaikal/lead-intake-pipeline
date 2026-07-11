import { config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { extract } from "./mock.js";
import type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

export type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

/** Runs the rule-based extractor, so the repo works with no API key in sight. */
class MockProvider implements LlmProvider {
  readonly name = "mock";

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    return {
      lead: extract(request.text, {
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
