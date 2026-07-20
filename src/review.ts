import { z } from "zod";

import { pool } from "./db.js";
import { ExtractedLead } from "./schema.js";

/**
 * The human-in-the-loop layer.
 *
 * Decides, per lead, whether the pipeline is allowed to answer on its own. If
 * it isn't, the lead stops before the CRM and waits for a person, and what that
 * person decides is stored so the next run can't undo it.
 *
 * Nothing here asks the model how confident it is. Self-reported confidence
 * tends to run highest on exactly the cases that are wrong. The two signals
 * used instead can both be checked: either the answer is impossible on its
 * face, or the two extractors already in this repo disagree.
 */

/**
 * Fields a person can be asked about. Kept short on purpose: `notes`,
 * `language` and `vehicle_types` don't change what happens to a lead, and a
 * queue that asks about everything stops getting worked.
 */
export const REVIEWABLE_FIELDS = [
  "customer_name",
  "contact",
  "service",
  "vehicle_count",
  "requested_date",
  "urgency",
] as const;
export type ReviewableField = (typeof REVIEWABLE_FIELDS)[number];

/**
 * Only nullable fields can be rejected outright. `service`, `urgency` and
 * `vehicle_count` have no empty value in the CRM contract, so on those "this is
 * wrong" has to come with a replacement. The schema is what decides that, not a
 * rule written down here.
 */
export const REJECTABLE_FIELDS: readonly ReviewableField[] = [
  "customer_name",
  "contact",
  "requested_date",
];

/**
 * Where a disagreement between extractors is worth a person's time. The parser
 * drops customer names constantly, so that tells us nothing, but a service or a
 * date the two read differently sends the lead somewhere else in the CRM.
 */
const DISAGREEMENT_FIELDS: readonly ReviewableField[] = [
  "service",
  "urgency",
  "requested_date",
  "vehicle_count",
];

export type FlagReason =
  "unreachable" | "unclassified" | "impossible_date" | "disagreement";

export interface Flag {
  field: ReviewableField;
  reason: FlagReason;
  /** What the pipeline proposes. */
  value: unknown;
  /** What the other extractor read, when the two disagreed. */
  alternative?: unknown;
  /** One line, shown to whoever works the queue. */
  note: string;
}

export interface OpenQuestionsInput {
  extracted: ExtractedLead;
  /** The deterministic parser's read of the same text, when a model produced the primary. */
  alternative: ExtractedLead | null;
  contactHint: string | null;
  /** The lead's own calendar day, so "in the past" means past for the customer. */
  today: string;
  /** Fields that need no person: already decided on this lead, or promoted by measured agreement. */
  settled: ReadonlySet<string>;
}

/**
 * What the pipeline can't answer on its own. No I/O in here, so the same inputs
 * always give the same flags: the queue can be explained to whoever works it,
 * and tested without a database.
 */
export function openQuestions(input: OpenQuestionsInput): Flag[] {
  const { extracted, alternative, contactHint, today, settled } = input;
  const flags: Flag[] = [];

  const add = (flag: Flag) => {
    if (settled.has(flag.field)) return;
    if (flags.some((existing) => existing.field === flag.field)) return;
    flags.push(flag);
  };

  if (extracted.contact === null && !contactHint) {
    add({
      field: "contact",
      reason: "unreachable",
      value: null,
      note: "no phone or email anywhere in the enquiry, so the CRM record would have no reply path",
    });
  }

  if (extracted.service === "other") {
    add({
      field: "service",
      reason: "unclassified",
      value: "other",
      note: "did not resolve to a service the CRM routes on",
    });
  }

  // A date behind the day the enquiry arrived is not a preference, it is a
  // resolution error — "el lunes" read against the wrong week, most often.
  if (extracted.requested_date !== null && extracted.requested_date < today) {
    add({
      field: "requested_date",
      reason: "impossible_date",
      value: extracted.requested_date,
      note: `resolved to ${extracted.requested_date}, which is before the enquiry arrived (${today})`,
    });
  }

  if (alternative) {
    for (const field of DISAGREEMENT_FIELDS) {
      if (extracted[field] === alternative[field]) continue;
      add({
        field,
        reason: "disagreement",
        value: extracted[field],
        alternative: alternative[field],
        note: `the model read ${JSON.stringify(extracted[field])}, the parser read ${JSON.stringify(alternative[field])}`,
      });
    }
  }

  return flags;
}

export const VERDICTS = ["accepted", "corrected", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Decision {
  field: ReviewableField;
  verdict: Verdict;
  /** What stands. Absent for `rejected`. */
  value?: unknown;
}

/**
 * Applies what people decided over whatever the extractor just produced.
 *
 * The order is the important bit: the fresh extraction goes down first, the
 * human decisions on top. A rejected field comes out null however many times
 * the machine finds the value again.
 */
export function mergeDecisions(
  extracted: ExtractedLead,
  decisions: readonly Decision[],
): ExtractedLead {
  const merged: Record<string, unknown> = { ...extracted };
  for (const decision of decisions) {
    if (decision.verdict === "accepted") continue;
    merged[decision.field] = decision.verdict === "rejected" ? null : decision.value;
  }
  return merged as ExtractedLead;
}

/** The payload the review UI posts. Values are checked against the CRM contract by the caller. */
export const DecisionInput = z.object({
  decisions: z
    .array(
      z
        .object({
          field: z.enum(REVIEWABLE_FIELDS),
          verdict: z.enum(VERDICTS),
          value: z.unknown().optional(),
        })
        .refine(
          (decision) =>
            decision.verdict !== "rejected" || REJECTABLE_FIELDS.includes(decision.field),
          {
            message:
              "this field has no empty value in the CRM contract — correct it instead",
          },
        ),
    )
    .min(1)
    .max(REVIEWABLE_FIELDS.length),
});

export interface DecisionRow extends Decision {
  machine_value: unknown;
  decided_at: Date;
}

export async function decisionsFor(leadId: number): Promise<DecisionRow[]> {
  const { rows } = await pool.query<DecisionRow>(
    `SELECT field, verdict, value, machine_value, decided_at
       FROM review_decisions WHERE lead_id = $1 ORDER BY field`,
    [leadId],
  );
  return rows;
}

/**
 * Records the decisions. Upsert, so a second pass over the same lead corrects
 * the first person's call instead of leaving two rows that disagree.
 *
 * `machine_value` is written once and never updated. It is what the extractor
 * proposed the first time anyone looked, and it is the column the agreement
 * figures are counted against; overwriting it on a second pass would score the
 * machine against a value a human had already put there.
 *
 * One statement rather than a query per field, so a submission cannot land
 * half-applied and leave the lead holding decisions nobody made.
 */
export async function saveDecisions(
  leadId: number,
  decisions: readonly Decision[],
  machineValues: Readonly<Record<string, unknown>>,
): Promise<void> {
  await pool.query(
    `INSERT INTO review_decisions (lead_id, field, verdict, machine_value, value)
     SELECT $1, field, verdict, machine_value::jsonb, value::jsonb
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS submitted(field, verdict, machine_value, value)
     ON CONFLICT (lead_id, field) DO UPDATE
            SET verdict = EXCLUDED.verdict,
                value = EXCLUDED.value,
                decided_at = now()`,
    [
      leadId,
      decisions.map((decision) => decision.field),
      decisions.map((decision) => decision.verdict),
      decisions.map((decision) => JSON.stringify(machineValues[decision.field] ?? null)),
      decisions.map((decision) =>
        JSON.stringify(decision.verdict === "rejected" ? null : (decision.value ?? null)),
      ),
    ],
  );
}

export interface PendingLead {
  id: number;
  channel: string;
  raw_text: string;
  review_flags: Flag[];
  received_at: Date;
}

export async function pendingReviews(limit = 50): Promise<PendingLead[]> {
  const { rows } = await pool.query<PendingLead>(
    `SELECT id, channel, raw_text, review_flags, received_at
       FROM leads WHERE status = 'needs_review' ORDER BY id LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface ReviewDetail extends PendingLead {
  status: string;
  extracted: ExtractedLead | null;
  extraction_source: string | null;
  decisions: DecisionRow[];
  rejectable: readonly string[];
}

export async function reviewDetail(leadId: number): Promise<ReviewDetail | null> {
  const { rows } = await pool.query(
    `SELECT id, channel, raw_text, status, extracted, extraction_source,
            review_flags, received_at
       FROM leads WHERE id = $1`,
    [leadId],
  );
  const lead = rows[0];
  if (!lead) return null;

  return {
    ...(lead as Omit<ReviewDetail, "decisions" | "rejectable">),
    decisions: await decisionsFor(leadId),
    rejectable: REJECTABLE_FIELDS,
  };
}

/**
 * Validates a merged lead against the CRM contract before anything is stored.
 * A correction typed by a person goes through the same schema the model's output
 * does, so "urgency: tomorrow" is refused here rather than at the CRM.
 */
export function checkMerged(merged: ExtractedLead) {
  return ExtractedLead.safeParse(merged);
}
