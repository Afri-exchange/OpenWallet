-- App state for the sandbox service: users, their one card, agents, spends, card fundings.
-- Tokens are stored only as SHA-256 hashes. KYC identity data is never stored (it goes straight to Miden).

CREATE TABLE app_user (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL UNIQUE,
  tier          TEXT NOT NULL DEFAULT 'quick' CHECK (tier IN ('quick', 'full')),
  kyc_reference TEXT UNIQUE,
  kyc_status    TEXT NOT NULL DEFAULT 'none',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One real card per user (Miden caps a customer at 3).
CREATE TABLE app_card (
  card_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL UNIQUE REFERENCES app_user(id),
  customer_id    TEXT NOT NULL,
  last_four      TEXT,
  per_txn_cents  BIGINT NOT NULL,
  daily_cents    BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HD derivation index of each deposit address, so the key can be re-derived from the mnemonic.
ALTER TABLE deposit_address ADD COLUMN derivation_index INTEGER UNIQUE;
CREATE SEQUENCE deposit_derivation_seq START 0 MINVALUE 0;

CREATE TABLE app_agent (
  card_id        TEXT NOT NULL REFERENCES app_card(card_id),
  agent_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  per_txn_cents  BIGINT NOT NULL,
  daily_cents    BIGINT NOT NULL,
  allowed_mccs   TEXT[],
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, agent_id)
);

-- Every payment attempt by an agent. idempotency_key is the agent's own key, scoped to the agent.
CREATE TABLE app_spend (
  spend_id        TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  merchant        TEXT NOT NULL,
  mcc             TEXT,
  status          TEXT NOT NULL CHECK (status IN ('processing', 'approved', 'declined', 'voided')),
  reason          TEXT,
  ledger_seq      BIGINT,
  miden_auth_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, agent_id, idempotency_key),
  FOREIGN KEY (card_id, agent_id) REFERENCES app_agent(card_id, agent_id)
);

-- Moving credited stablecoin onto the Miden card (holding -> pending -> card).
CREATE TABLE app_funding (
  funding_id   TEXT PRIMARY KEY,
  card_id      TEXT NOT NULL REFERENCES app_card(card_id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status       TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'released')),
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
