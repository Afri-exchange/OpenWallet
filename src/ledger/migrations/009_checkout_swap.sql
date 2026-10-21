-- Checkout swap: an agent pays a third-party hosted checkout (Stripe-style). Our server fills the page with the
-- owner's vaulted card; the agent never sees the card. The money moves through app_spend under the key
-- checkout:swap:<swap_id>, so the agent's limits, balance and ledger apply as for any payment.

CREATE TABLE app_checkout_swap (
  swap_id          TEXT PRIMARY KEY,
  card_id          TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  checkout_url     TEXT NOT NULL,
  checkout_host    TEXT NOT NULL,
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  merchant         TEXT NOT NULL,
  mcc              TEXT CHECK (mcc ~ '^\d{4}$'),
  -- pending: row written, nothing charged yet. filling: the browser has (or may have) the card.
  -- paid / failed: final. challenge: a captcha or 3DS stopped us (never retried automatically).
  -- processing: we cannot tell whether the card was charged; reconcile decides. needs_review: a person must look.
  status           TEXT NOT NULL CHECK (status IN ('pending', 'filling', 'processing', 'paid', 'failed', 'challenge', 'needs_review')),
  -- What the filler reported: succeeded, declined, amount_mismatch, captcha, three_ds, unsupported_page, error.
  outcome          TEXT,
  -- Short, card-free description of what happened (never page DOM, never card data).
  detail           TEXT,
  -- Whether the card form was submitted: false means the card cannot have been charged by this attempt.
  submitted        BOOLEAN NOT NULL DEFAULT false,
  spend_id         TEXT,
  -- The card network's Authorization matched to this swap by reconcile; one transaction pays one swap.
  card_txn_ref     TEXT UNIQUE,
  -- The merchant category the card network saw (merchantMcc on that Authorization): the real one, not the agent's claim.
  card_mcc         TEXT,
  -- Set when a person should look at a swap that is otherwise settled (MCC differs from the declared one, a "paid"
  -- page with no card authorization behind it, several possible matches).
  review           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, agent_id, idempotency_key),
  FOREIGN KEY (card_id, agent_id) REFERENCES app_agent(card_id, agent_id)
);

CREATE INDEX app_checkout_swap_unconfirmed ON app_checkout_swap (created_at) WHERE status = 'paid' AND card_txn_ref IS NULL AND review IS NULL;
CREATE INDEX app_checkout_swap_open ON app_checkout_swap (status, created_at) WHERE status IN ('filling', 'processing', 'challenge');
