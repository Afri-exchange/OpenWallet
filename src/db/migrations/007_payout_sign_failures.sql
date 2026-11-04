-- Signing attempts that failed while the payout account had enough USDC and gas, so the cause is this payout
-- (e.g. its destination makes the transfer revert). After a few, the payout fails and its money is released.
ALTER TABLE app_payout ADD COLUMN sign_failures INTEGER NOT NULL DEFAULT 0;
