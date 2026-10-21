-- Checkouts: a merchant fixes the price, an agent pays it with its owner's card. Payment goes through
-- app_spend like any agent payment; a checkout is paid at most once.

CREATE TABLE app_merchant (
  merchant_id  TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  -- Default merchant category for its checkouts (agents' MCC allowlists apply to it).
  mcc          TEXT CHECK (mcc ~ '^\d{4}$'),
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_checkout (
  checkout_id      TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL REFERENCES app_merchant(merchant_id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  description      TEXT NOT NULL,
  -- The merchant's own order id, echoed back.
  reference        TEXT,
  mcc              TEXT CHECK (mcc ~ '^\d{4}$'),
  metadata         JSONB,
  idempotency_key  TEXT,
  status           TEXT NOT NULL CHECK (status IN ('open', 'processing', 'paid', 'canceled', 'expired')),
  -- The agent holding the claim (processing) or that paid (paid). Cleared when an attempt fails.
  card_id          TEXT,
  agent_id         TEXT,
  -- Each claim is a new attempt with its own spend idempotency key: checkout:<id>:<attempt>.
  attempt          INTEGER NOT NULL DEFAULT 0,
  claimed_at       TIMESTAMPTZ,
  spend_id         TEXT UNIQUE REFERENCES app_spend(spend_id),
  -- Internal only (the payer's limits are private); merchants see lastAttempt = "failed".
  last_error       TEXT,
  -- Set when a person must look: a charge that does not match, or one approved after the checkout moved on.
  needs_review     TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key),
  CHECK ((status IN ('processing', 'paid')) = (agent_id IS NOT NULL))
);

CREATE INDEX app_checkout_merchant ON app_checkout (merchant_id, created_at DESC);
CREATE INDEX app_checkout_processing ON app_checkout (claimed_at) WHERE status = 'processing';
