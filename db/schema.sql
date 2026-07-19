-- Idempotent schema. `npm run migrate` applies it; re-running is a no-op.

CREATE TABLE IF NOT EXISTS leads (
  id              bigserial PRIMARY KEY,
  -- The dedup key. A webhook that fires twice carries the same one, so the
  -- second insert collides here instead of creating a second lead.
  idempotency_key text        NOT NULL UNIQUE,
  channel         text        NOT NULL,
  raw_text        text        NOT NULL,
  contact_hint    text,
  status          text        NOT NULL DEFAULT 'queued',
  extracted       jsonb,
  extraction_source text,
  -- What the last run could not answer on its own. Stored rather than
  -- recomputed, so the queue shows what the machine actually thought at the
  -- time instead of what today's rules would say about yesterday's lead.
  review_flags    jsonb,
  received_at     timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- For databases created before the review layer existed.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS review_flags jsonb;

CREATE TABLE IF NOT EXISTS jobs (
  id          bigserial PRIMARY KEY,
  lead_id     bigint      NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'queued',
  attempts    int         NOT NULL DEFAULT 0,
  max_attempts int        NOT NULL DEFAULT 5,
  run_after   timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  locked_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The index the claim query rides. Partial, so it stays small as done rows pile up.
CREATE INDEX IF NOT EXISTS jobs_claimable_idx
  ON jobs (run_after)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS steps (
  id         bigserial PRIMARY KEY,
  lead_id    bigint      NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  ok         boolean     NOT NULL,
  detail     text,
  ms         int         NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS steps_lead_idx ON steps (lead_id, id);

-- One row per model call. This table *is* the cost control: the ceiling is
-- enforced by summing it, so spend can never be inferred from an estimate.
CREATE TABLE IF NOT EXISTS llm_calls (
  id             bigserial PRIMARY KEY,
  lead_id        bigint REFERENCES leads(id) ON DELETE SET NULL,
  model          text        NOT NULL,
  input_tokens   int         NOT NULL,
  output_tokens  int         NOT NULL,
  cost_micro_usd bigint      NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_calls_created_idx ON llm_calls (created_at);

-- What a person ruled on, one row per (lead, field).
--
-- `machine_value` is kept beside `value` because the two together are the only
-- honest way to measure the extractor: agreement is how often a human left the
-- machine's answer alone, and that question cannot be asked of a table that
-- overwrote the machine's answer with the human's.
--
-- A 'rejected' row is a tombstone. Without it, re-processing a lead would put
-- back the value a person deleted — the machine finds it again every time, and
-- deletion that does not survive the next run is not deletion.
CREATE TABLE IF NOT EXISTS review_decisions (
  id            bigserial PRIMARY KEY,
  lead_id       bigint      NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  field         text        NOT NULL,
  verdict       text        NOT NULL CHECK (verdict IN ('accepted', 'corrected', 'rejected')),
  machine_value jsonb,
  value         jsonb,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, field)
);

CREATE INDEX IF NOT EXISTS review_decisions_field_idx ON review_decisions (field);

-- Stands in for the CRM and the notifier when no webhook URL is configured,
-- so the demo has somewhere real to deliver to.
CREATE TABLE IF NOT EXISTS deliveries (
  id         bigserial PRIMARY KEY,
  lead_id    bigint      NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sink       text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
