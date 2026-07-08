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
  id         bigserial PRIMARY KEY,
  lead_id    bigint      NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status     text        NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now()
);
