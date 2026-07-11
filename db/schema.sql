CREATE TABLE IF NOT EXISTS leads (
  id           bigserial PRIMARY KEY,
  channel      text        NOT NULL,
  raw_text     text        NOT NULL,
  contact_hint text,
  status       text        NOT NULL DEFAULT 'queued',
  extracted    jsonb,
  extraction_source text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS jobs (
  id          bigserial PRIMARY KEY,
  lead_id     bigint      NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'queued',
  attempts    int         NOT NULL DEFAULT 0,
  max_attempts int        NOT NULL DEFAULT 5,
  run_after   timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The index the claim query rides. Partial, so it stays small as done rows pile up.
CREATE INDEX IF NOT EXISTS jobs_claimable_idx
  ON jobs (run_after)
  WHERE status = 'queued';

-- One row per pipeline step, so a lead that went wrong says where.
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
