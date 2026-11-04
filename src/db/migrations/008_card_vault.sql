-- Card vault (src/vault/vault.ts): full card details captured at issue, AES-256-GCM sealed by the app
-- (CARD_VAULT_KEY never reaches the database). last4 is kept in the clear for matching and display.
CREATE TABLE card_vault (
  card_id    TEXT PRIMARY KEY,
  key_id     TEXT NOT NULL,
  iv         BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  tag        BYTEA NOT NULL,
  last4      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('issue', 'full-pan')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per put and per reveal attempt (including misses). Append-only by convention: nothing updates or deletes it.
CREATE TABLE card_vault_audit (
  id      BIGSERIAL PRIMARY KEY,
  card_id TEXT NOT NULL,
  action  TEXT NOT NULL CHECK (action IN ('put', 'overwrite', 'reveal', 'reveal_miss')),
  purpose TEXT NOT NULL,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX card_vault_audit_card ON card_vault_audit (card_id, at);
