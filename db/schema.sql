CREATE TABLE IF NOT EXISTS leads (
  id           bigserial PRIMARY KEY,
  channel      text        NOT NULL,
  raw_text     text        NOT NULL,
  status       text        NOT NULL DEFAULT 'queued',
  extracted    jsonb,
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
