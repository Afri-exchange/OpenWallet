-- USDC payouts (Base Sepolia, testnet only). A merchant sets a payout address; each payout snapshots the
-- address it was requested to, so a later change cannot redirect it.

ALTER TABLE app_merchant
  ADD COLUMN payout_address TEXT CHECK (payout_address ~ '^0x[0-9a-f]{40}$'),
  -- Payouts to a newly set address are refused until the change is old enough (account-takeover delay).
  ADD COLUMN payout_address_set_at TIMESTAMPTZ;

-- sending: signed and stored (raw_tx) before broadcast; settled from the chain by its hash.
ALTER TABLE app_payout DROP CONSTRAINT app_payout_status_check;
ALTER TABLE app_payout ADD CONSTRAINT app_payout_status_check CHECK (status IN ('requested', 'sending', 'sent', 'failed'));
ALTER TABLE app_payout
  ADD COLUMN destination TEXT CHECK (destination ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN chain TEXT,
  ADD COLUMN raw_tx TEXT,
  ADD COLUMN nonce BIGINT,
  -- Why a requested payout has not gone out yet (e.g. the payout account is short of USDC); internal.
  ADD COLUMN last_error TEXT,
  -- Set when a person must look (our nonce was taken by another transaction). The money stays reserved.
  ADD COLUMN needs_review TEXT;

CREATE UNIQUE INDEX app_payout_rail_reference ON app_payout (rail_reference) WHERE rail_reference IS NOT NULL;
-- One transfer in flight at a time keeps nonces in order.
CREATE UNIQUE INDEX app_payout_one_sending ON app_payout ((true)) WHERE status = 'sending';
CREATE INDEX app_payout_queue ON app_payout (created_at) WHERE status = 'requested';
