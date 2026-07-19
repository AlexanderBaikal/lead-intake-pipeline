import { config } from "./config.js";
import { pool } from "./db.js";
import { REVIEWABLE_FIELDS, type ReviewableField } from "./review.js";

/**
 * How often a person left the extractor's answer alone.
 *
 * Every review produces a labelled example for free — the machine proposed
 * something, a human either kept it or did not — so the queue pays for itself
 * twice: once by catching the bad record, and again by measuring the extractor
 * on real traffic instead of on a fixture set someone wrote by hand.
 *
 * The measurement is then spent: a field that has been right often enough, over
 * enough decisions, stops being asked about. That is the only mechanism here
 * that reduces manual work, and it is deliberately the one with a number
 * attached rather than a feeling.
 */

export interface FieldAgreement {
  field: ReviewableField;
  /** Decisions recorded on this field. */
  decided: number;
  /** Of those, how many kept the machine's value. */
  accepted: number;
  /** null until anything has been decided — an unmeasured field is not a perfect one. */
  rate: number | null;
  /** Whether this field currently skips review. */
  auto: boolean;
}

export interface PromotionRules {
  threshold: number;
  minDecisions: number;
}

/**
 * Pure: given counts, which fields have earned their way out of the queue.
 *
 * `minDecisions` is what stops three lucky calls in a row from switching a field
 * off. Both halves have to hold — a rate on two samples is not a rate.
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
