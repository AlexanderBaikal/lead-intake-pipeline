import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { config } from "../config.js";
import { ExtractedLead } from "../schema.js";
import { extract } from "./mock.js";
import type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

const MAX_OUTPUT_TOKENS = 1_024;

const SYSTEM = [
  "You normalize inbound service enquiries for a vehicle-care business in Panama.",
  "Enquiries arrive as free text, in Spanish or English, often mixed, misspelled, or truncated.",
  "Extract only what the text actually says. Leave a field null rather than guessing it:",
  "an unfilled field costs a human ten seconds, an invented one costs a wrong appointment.",
  "Resolve relative dates ('mañana', 'next Friday') against the reference date given in the message.",
].join(" ");

function userPrompt(request: ExtractRequest): string {
  const reference = request.referenceDate.toISOString().slice(0, 10);
  return [
    `Reference date (today): ${reference}`,
    request.contactHint ? `Contact known from the channel: ${request.contactHint}` : null,
    "Enquiry:",
    request.text,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";

  private readonly client = new Anthropic({ apiKey: config.anthropicApiKey });

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const response = await this.client.messages.parse({
      model: config.llmModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      output_config: { format: zodOutputFormat(ExtractedLead) },
      messages: [{ role: "user", content: userPrompt(request) }],
    });

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    // Two ways a structurally-valid request still yields no usable object:
    // the model declined, or it hit the token cap mid-object. Neither is worth
    // failing the lead over — parse it with the rules and mark the row.
    if (response.stop_reason === "refusal" || response.parsed_output === null) {
      return {
        lead: extract(request.text, {
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
