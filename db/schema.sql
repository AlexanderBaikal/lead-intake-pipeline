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
  received_at     timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

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

-- Stands in for the CRM and the notifier when no webhook URL is configured,
-- so the demo has somewhere real to deliver to.
CREATE TABLE IF NOT EXISTS deliveries (
  id         bigserial PRIMARY KEY,
  lead_id    bigint      NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sink       text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
