import type { ExtractedLead } from "../schema.js";

export interface ExtractRequest {
  text: string;
  contactHint: string | null;
  referenceDate: Date;
}

export interface ExtractResult {
  lead: ExtractedLead;
  /** `model` when the LLM produced it, `heuristic` when the rules did. */
  source: "model" | "heuristic";
  /** The model that ran, or null when nothing billable did. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  extract(request: ExtractRequest): Promise<ExtractResult>;
}
