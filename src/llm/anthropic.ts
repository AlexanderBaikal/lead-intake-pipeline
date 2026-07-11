import Anthropic from "@anthropic-ai/sdk";

import { config } from "../config.js";
import { ExtractedLead } from "../schema.js";
import type { ExtractRequest, ExtractResult, LlmProvider } from "./provider.js";

const MAX_OUTPUT_TOKENS = 1_024;

const SYSTEM = [
  "You normalize inbound service enquiries for a vehicle-care business in Panama.",
  "Enquiries arrive as free text, in Spanish or English, often mixed, misspelled, or truncated.",
  "Extract only what the text actually says. Leave a field null rather than guessing it:",
  "an unfilled field costs a human ten seconds, an invented one costs a wrong appointment.",
  "Resolve relative dates ('mañana', 'next Friday') against the reference date given in the message.",
  "",
  "Reply with JSON only, no prose, matching exactly:",
  '{"customer_name": string|null, "contact": string|null,',
  '"service": "wash"|"detailing"|"repair"|"inspection"|"subscription"|"other",',
  '"vehicle_count": number, "vehicle_types": string[],',
  '"requested_date": "YYYY-MM-DD"|null,',
  '"urgency": "asap"|"today"|"this_week"|"flexible",',
  '"language": "es"|"en"|"other", "notes": string}',
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
    const response = await this.client.messages.create({
      model: config.llmModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt(request) }],
    });

    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    return {
      lead: ExtractedLead.parse(JSON.parse(text)),
      source: "model",
      model: config.llmModel,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
