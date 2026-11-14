import { sql } from "drizzle-orm";
import { bigserial, check, foreignKey, index, pgTable, text } from "drizzle-orm/pg-core";
import { bigintNumber, timestamptz } from "./columns.js";

// Append-only double-entry ledger (migration 001). Amounts are integer USD cents. The append-only triggers and
// ledger_check_balances() live in the SQL migration: Drizzle does not model triggers or functions.

export const ledgerTx = pgTable(
  "ledger_tx",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique("ledger_tx_idempotency_key_key"),
    kind: text("kind").notNull(),
    reference: text("reference"),
    /** At most one reversal per original transaction. */
    reversesSeq: bigintNumber("reverses_seq").unique("ledger_tx_reverses_seq_key"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "ledger_tx_reverses_seq_fkey", columns: [t.reversesSeq], foreignColumns: [t.seq] }),
    check("ledger_tx_idempotency_key_check", sql`${t.idempotencyKey} <> ''`),
    check("ledger_tx_kind_check", sql`${t.kind} <> ''`),
  ],
);

export const ledgerPosting = pgTable(
  "ledger_posting",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    txSeq: bigintNumber("tx_seq").notNull(),
    account: text("account").notNull(),
    amountCents: bigintNumber("amount_cents").notNull(),
  },
  (t) => [
    foreignKey({ name: "ledger_posting_tx_seq_fkey", columns: [t.txSeq], foreignColumns: [ledgerTx.seq] }),
    index("ledger_posting_account").on(t.account, t.id),
    index("ledger_posting_tx").on(t.txSeq),
    check("ledger_posting_account_check", sql`${t.account} ~ '^[a-z][a-z_]*:\\S+$'`),
    check("ledger_posting_amount_cents_check", sql`${t.amountCents} <> 0`),
  ],
);

/**
 * Running balance per account, updated in the same transaction as the postings. Its row lock serialises concurrent
 * writers to one account; the CHECK is the last line of defence against overdraft (only external:* and fees:* may go
 * negative).
 */
export const ledgerBalance = pgTable(
  "ledger_balance",
  {
    account: text("account").primaryKey(),
    balanceCents: bigintNumber("balance_cents").notNull().default(0),
  },
  (t) => [check("ledger_balance_no_overdraft", sql`${t.balanceCents} >= 0 OR ${t.account} ~ '^(external|fees):'`)],
);
