import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { config } from "../config.js";
import { ExtractedLead } from "../schema.js";
import { localDateISO } from "../time.js";
import { heuristicExtract } from "./heuristic.js";
import type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

/**
 * The response cap. The budget gate prices every call against this same number
 * as its worst case, so the ceiling is enforced against what the call can
 * actually spend rather than against a second literal that drifted from it.
 */
const MAX_OUTPUT_TOKENS = 1_024;

const SYSTEM = [
  "You normalize inbound service enquiries for a vehicle-care business in Panama.",
  "Enquiries arrive as free text, in Spanish or English, often mixed, misspelled, or truncated.",
  "Extract only what the text actually says. Leave a field null rather than guessing it:",
  "an unfilled field costs a human ten seconds, an invented one costs a wrong appointment.",
  "Resolve relative dates ('mañana', 'next Friday') against the reference date given in the message.",
].join(" ");

/**
 * The prompt is assembled stable-part-first so the system block and the
 * instructions stay byte-identical across leads. Only the tail varies, which
 * is what makes the cached prefix reusable at ~0.1x input price.
 */
function userPrompt(request: ExtractRequest): string {
  // The business calendar day, not the UTC one — see src/time.ts.
  const reference = localDateISO(request.referenceDate, config.businessTimeZone);
  return [
    `Reference date (today, ${config.businessTimeZone}): ${reference}`,
    request.contactHint ? `Contact known from the channel: ${request.contactHint}` : null,
    "Enquiry:",
    request.text,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly metered = true;
  readonly maxOutputTokens = MAX_OUTPUT_TOKENS;

  private readonly client: Anthropic;

  constructor(client: Anthropic = new Anthropic({ apiKey: config.anthropicApiKey })) {
    this.client = client;
  }

  async estimateInputTokens(request: ExtractRequest): Promise<number> {
    const counted = await this.client.messages.countTokens({
      model: config.llmModel,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt(request) }],
    });
    return counted.input_tokens;
  }

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const response = await this.client.messages.parse({
      model: config.llmModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      // Extraction is a shallow task; the depth this buys goes to parsing
      // sloppy input, not to reasoning about it.
      output_config: {
        effort: "low",
        format: zodOutputFormat(ExtractedLead),
      },
      messages: [{ role: "user", content: userPrompt(request) }],
    });

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    // Two ways a structurally-valid request still yields no usable object:
    // the model declined, or it hit the token cap mid-object. Neither is worth
    // failing the lead over — parse it locally and mark the row accordingly.
    if (response.stop_reason === "refusal" || response.parsed_output === null) {
      return {
        lead: heuristicExtract(request.text, {
          referenceDate: request.referenceDate,
          contactHint: request.contactHint,
        }),
        source: "heuristic",
        model: config.llmModel,
        ...usage,
      };
    }

    return {
      lead: response.parsed_output,
      source: "model",
      model: config.llmModel,
      ...usage,
    };
  }
}
