-- Append-only double-entry ledger. Amounts are integer USD cents.

CREATE TABLE ledger_tx (
  seq             BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key <> ''),
  kind            TEXT NOT NULL CHECK (kind <> ''),
  reference       TEXT,
  -- At most one reversal per original transaction.
  reverses_seq    BIGINT UNIQUE REFERENCES ledger_tx(seq),
  created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE ledger_posting (
  id           BIGSERIAL PRIMARY KEY,
  tx_seq       BIGINT NOT NULL REFERENCES ledger_tx(seq),
  account      TEXT NOT NULL CHECK (account ~ '^[a-z][a-z_]*:\S+$'),
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0)
);
CREATE INDEX ledger_posting_account ON ledger_posting (account, id);
CREATE INDEX ledger_posting_tx ON ledger_posting (tx_seq);

-- Running balance per account, updated in the same transaction as the postings. Its row lock is
-- what serialises concurrent writers to one account, and the CHECK is the last line of defence
-- against overdraft. Only external:* and fees:* may be negative. ledger_check_balances() proves
-- it still equals the sum of the postings.
CREATE TABLE ledger_balance (
  account       TEXT PRIMARY KEY,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT ledger_balance_no_overdraft CHECK (balance_cents >= 0 OR account ~ '^(external|fees):')
);

CREATE FUNCTION ledger_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only'; END $$;

CREATE TRIGGER ledger_tx_immutable BEFORE UPDATE OR DELETE ON ledger_tx FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
CREATE TRIGGER ledger_posting_immutable BEFORE UPDATE OR DELETE ON ledger_posting FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
CREATE TRIGGER ledger_tx_no_truncate BEFORE TRUNCATE ON ledger_tx FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();
CREATE TRIGGER ledger_posting_no_truncate BEFORE TRUNCATE ON ledger_posting FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();

-- Integrity probe: returns accounts whose stored balance differs from the sum of their postings.
-- Also flags a non-zero grand total (empty account name) so zero-sum is checked too.
CREATE FUNCTION ledger_check_balances() RETURNS TABLE (account TEXT, stored_cents BIGINT, derived_cents BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(b.account, p.account), COALESCE(b.balance_cents, 0), COALESCE(p.s, 0)
  FROM ledger_balance b
  FULL JOIN (SELECT account, SUM(amount_cents)::BIGINT AS s FROM ledger_posting GROUP BY account) p ON p.account = b.account
  WHERE COALESCE(b.balance_cents, 0) <> COALESCE(p.s, 0)
  UNION ALL
  SELECT '', 0, COALESCE(SUM(amount_cents), 0)::BIGINT FROM ledger_posting HAVING COALESCE(SUM(amount_cents), 0) <> 0
$$;
