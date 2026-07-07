CREATE TABLE IF NOT EXISTS leads (
  id          bigserial PRIMARY KEY,
  channel     text        NOT NULL,
  raw_text    text        NOT NULL,
  status      text        NOT NULL DEFAULT 'new',
  received_at timestamptz NOT NULL DEFAULT now()
);
