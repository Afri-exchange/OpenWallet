-- Merchant settlement: a paid checkout credits the merchant's balance in our ledger
-- (merchant:<id>, key checkout-settle:<checkout_id>); merchants are paid out from it.

-- The ledger seq that credited the merchant. A paid checkout with none is settled by CheckoutService.sync().
ALTER TABLE app_checkout ADD COLUMN settled_seq BIGINT;
CREATE INDEX app_checkout_unsettled ON app_checkout (paid_at) WHERE status = 'paid' AND settled_seq IS NULL;

CREATE TABLE app_payout (
  payout_id        TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL REFERENCES app_merchant(merchant_id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  -- requested: reserved in the ledger (merchant -> payout_pending), not yet confirmed sent.
  -- sent: the rail confirmed it. failed: the rail definitely refused it; the money went back to the balance.
  status           TEXT NOT NULL CHECK (status IN ('requested', 'sent', 'failed')),
  idempotency_key  TEXT,
  -- The rail's id for the transfer, once there is a rail.
  rail_reference   TEXT,
  failure          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);

CREATE INDEX app_payout_merchant ON app_payout (merchant_id, created_at DESC);
