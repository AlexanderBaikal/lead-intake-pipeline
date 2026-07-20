import { config } from "./config.js";
import { pool } from "./db.js";
import { REVIEWABLE_FIELDS, type ReviewableField } from "./review.js";

/**
 * How often a person left the extractor's answer alone.
 *
 * Every review produces a labelled example for free: the machine proposed
 * something and a human either kept it or didn't. So the queue catches the bad
 * record and, on the way, measures the extractor against real traffic rather
 * than against a fixture set written by hand.
 *
 * The measurement then gets spent. A field that has been right often enough,
 * over enough decisions, stops being asked about, and that is the only thing
 * here that reduces the manual work over time.
 */

export interface FieldAgreement {
  field: ReviewableField;
  /** Decisions recorded on this field. */
  decided: number;
  /** Of those, how many kept the machine's value. */
  accepted: number;
  /** null until something has been decided, so an unmeasured field reads as unmeasured. */
  rate: number | null;
  /** Whether this field currently skips review. */
  auto: boolean;
}

export interface PromotionRules {
  threshold: number;
  minDecisions: number;
}

/**
 * Given the counts, which fields have earned their way out of the queue.
 *
 * `minDecisions` is what stops three lucky calls in a row from switching a
 * field off; both halves have to hold before anything is promoted.
 */
export function promote(
  counts: ReadonlyArray<{ field: ReviewableField; decided: number; accepted: number }>,
  rules: PromotionRules,
): FieldAgreement[] {
  return REVIEWABLE_FIELDS.map((field) => {
    const row = counts.find((candidate) => candidate.field === field);
    const decided = row?.decided ?? 0;
    const accepted = row?.accepted ?? 0;
    const rate = decided === 0 ? null : accepted / decided;
    return {
      field,
      decided,
      accepted,
      rate,
      auto: decided >= rules.minDecisions && rate !== null && rate >= rules.threshold,
    };
  });
}

const rules: PromotionRules = {
  threshold: config.reviewAgreementThreshold,
  minDecisions: config.reviewMinDecisions,
};

async function counts() {
  const { rows } = await pool.query<{
    field: ReviewableField;
    decided: string;
    accepted: string;
  }>(
    `SELECT field,
            count(*)                                        AS decided,
            count(*) FILTER (WHERE verdict = 'accepted')    AS accepted
       FROM review_decisions
      GROUP BY field`,
  );
  return rows.map((row) => ({
    field: row.field,
    decided: Number(row.decided),
    accepted: Number(row.accepted),
  }));
}

export async function agreementByField(): Promise<FieldAgreement[]> {
  return promote(await counts(), rules);
}

/** The fields the pipeline no longer stops on, because the measurement says it need not. */
export async function autoAcceptedFields(): Promise<Set<string>> {
  const rows = await agreementByField();
  return new Set(rows.filter((row) => row.auto).map((row) => row.field));
}

export const promotionRules = rules;
