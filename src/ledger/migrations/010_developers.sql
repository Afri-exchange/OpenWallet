-- Developer layer: a developer integrates agent-cards into their own product and creates end users under their account.
-- Keys, sessions are stored only as SHA-256 hashes. The webhook secret must be kept readable (we sign with it).

CREATE TABLE app_developer (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  key_hash       TEXT NOT NULL UNIQUE,
  -- Privacy mode: each payment is made with a fresh one-time card instead of the user's own card.
  privacy_mode   BOOLEAN NOT NULL DEFAULT false,
  webhook_url    TEXT,
  webhook_secret TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users made through the developer API. external_id is the developer's own id for the user.
ALTER TABLE app_user ADD COLUMN developer_id TEXT REFERENCES app_developer(id);
ALTER TABLE app_user ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX app_user_developer_external ON app_user (developer_id, external_id) WHERE developer_id IS NOT NULL;

-- Short-lived tokens the developer hands to an end user's browser (hosted KYC and spend controls).
CREATE TABLE app_session (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES app_user(id),
  developer_id TEXT NOT NULL REFERENCES app_developer(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_session_user ON app_session (user_id);

-- Webhook outbox: one row per event per developer, delivered with retries.
CREATE TABLE app_webhook_event (
  id              TEXT PRIMARY KEY,
  developer_id    TEXT NOT NULL REFERENCES app_developer(id),
  type            TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);
CREATE INDEX app_webhook_due ON app_webhook_event (next_attempt_at) WHERE status = 'pending';
