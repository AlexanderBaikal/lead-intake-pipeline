import type { ExtractedLead } from "../schema.js";

export interface ExtractRequest {
  text: string;
  contactHint: string | null;
  referenceDate: Date;
}

export interface ExtractResult {
  lead: ExtractedLead;
  /** `model` when the LLM produced it, `heuristic` when the fallback did. */
  source: "model" | "heuristic";
  /**
   * Which model ran, or null when none did. This is not a billing signal: a
   * local model names itself here and still costs nothing. What gets billed is
   * decided by the provider's `metered` flag.
   */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;

  /**
   * Whether calls cost money. The pipeline gates on this rather than on the
   * provider's name, so adding a provider never means editing the pipeline.
   */
  readonly metered: boolean;

  /**
   * The model this provider runs, or null when it runs none. Reported rather
   * than derived from `metered`, so a free local model can still say which one
   * answered.
   */
  readonly model: string | null;

  /**
   * The cap this provider passes as `max_tokens`. The budget gate prices the
   * worst case against it, so the two cannot drift into a ceiling that is
   * enforced against a number the call never actually used.
   */
  readonly maxOutputTokens: number;

  extract(request: ExtractRequest): Promise<ExtractResult>;

  /** Priced ahead of the call, so the budget gate can refuse before spending. */
  estimateInputTokens(request: ExtractRequest): Promise<number>;
}
