import { asc, eq, inArray, sql } from "drizzle-orm";
import type { LedgerTransaction } from "../../lib/services/Ledger.js";
import {
  DuplicateKeyError,
  OverdraftError,
  type IntegrityIssue,
  type LedgerRepository,
  type NewStoredTransaction,
  type StoreTx,
} from "../../domain/repositories/LedgerStore.js";
import { PgCode, pgError, type Database, type Executor } from "../client.js";
import { ledgerBalance, ledgerPosting, ledgerTx } from "../schema/index.js";
import { toSafeInt } from "../schema/columns.js";

type TxRow = typeof ledgerTx.$inferSelect;
type PostingRow = Pick<typeof ledgerPosting.$inferSelect, "txSeq" | "account" | "amountCents">;

const postingColumns = { txSeq: ledgerPosting.txSeq, account: ledgerPosting.account, amountCents: ledgerPosting.amountCents };

function hydrate(r: TxRow, postings: PostingRow[]): LedgerTransaction {
  const tx: LedgerTransaction = {
    seq: r.seq,
    idempotencyKey: r.idempotencyKey,
    kind: r.kind,
    postings: postings.map((p) => ({ account: p.account, amountCents: p.amountCents })),
    createdAt: r.createdAt.toISOString(),
  };
  if (r.reference !== null) tx.reference = r.reference;
  if (r.reversesSeq !== null) tx.reversesSeq = r.reversesSeq;
  return tx;
}

async function loadOne(q: Executor, where: ReturnType<typeof eq>): Promise<LedgerTransaction | undefined> {
  const [row] = await q.select().from(ledgerTx).where(where);
  if (!row) return undefined;
  const postings = await q.select(postingColumns).from(ledgerPosting).where(eq(ledgerPosting.txSeq, row.seq)).orderBy(asc(ledgerPosting.id));
  return hydrate(row, postings);
}

/** Translates the constraint violations the ledger relies on into its own errors. */
function mapError(e: unknown): unknown {
  const err = pgError(e);
  if (err?.code === PgCode.uniqueViolation) return new DuplicateKeyError(err.constraint ?? "duplicate key");
  if (err?.code === PgCode.checkViolation && err.constraint === "ledger_balance_no_overdraft") return new OverdraftError("insufficient funds");
  return e;
}

/** The operations valid inside one ledger transaction, bound to that transaction. */
function txView(tx: Executor): StoreTx {
  return {
    lock: async (accounts) => {
      const sorted = [...new Set(accounts)].sort();
      if (sorted.length === 0) return new Map();
      await tx.insert(ledgerBalance).values(sorted.map((account) => ({ account }))).onConflictDoNothing();
      // Locked in a stable order, so concurrent writers to overlapping accounts cannot deadlock.
      const rows = await tx
        .select()
        .from(ledgerBalance)
        .where(inArray(ledgerBalance.account, sorted))
        .orderBy(asc(ledgerBalance.account))
        .for("update");
      return new Map(rows.map((r) => [r.account, r.balanceCents]));
    },
    findByKey: (key) => loadOne(tx, eq(ledgerTx.idempotencyKey, key)),
    findBySeq: (seq) => loadOne(tx, eq(ledgerTx.seq, seq)),
    append: async (t: NewStoredTransaction) => {
      const [ins] = await tx
        .insert(ledgerTx)
        .values({
          idempotencyKey: t.idempotencyKey,
          kind: t.kind,
          reference: t.reference ?? null,
          reversesSeq: t.reversesSeq ?? null,
          createdAt: new Date(t.createdAt),
        })
        .returning({ seq: ledgerTx.seq });
      const seq = ins!.seq;
      await tx.insert(ledgerPosting).values(t.postings.map((p) => ({ txSeq: seq, account: p.account, amountCents: p.amountCents })));
      // Callers lock() every touched account first, so these rows exist and are ours.
      const net = new Map<string, number>();
      for (const p of t.postings) net.set(p.account, (net.get(p.account) ?? 0) + p.amountCents);
      for (const [account, delta] of [...net].sort(([a], [b]) => (a < b ? -1 : 1))) {
        await tx
          .update(ledgerBalance)
          .set({ balanceCents: sql`${ledgerBalance.balanceCents} + ${toSafeInt(delta)}::bigint` })
          .where(eq(ledgerBalance.account, account));
      }
      return { seq, ...t };
    },
  };
}

/**
 * Postgres ledger store. Each transaction runs at READ COMMITTED but takes row locks on the balance rows of every
 * account it touches before reading them, so concurrent reserves/spends on one account queue up and the second sees
 * the first one's committed balance. The CHECK on ledger_balance backstops it.
 */
export const createLedgerStore = (db: Database): LedgerRepository => ({
  async transaction(fn) {
    try {
      return await db.transaction((tx) => fn(txView(tx)));
    } catch (e) {
      throw mapError(e);
    }
  },

  async balance(account) {
    const [row] = await db.select({ cents: ledgerBalance.balanceCents }).from(ledgerBalance).where(eq(ledgerBalance.account, account));
    return row?.cents ?? 0;
  },

  async history(account) {
    const involved = db.select({ seq: ledgerPosting.txSeq }).from(ledgerPosting).where(eq(ledgerPosting.account, account));
    const txs = await db.select().from(ledgerTx).where(inArray(ledgerTx.seq, involved)).orderBy(asc(ledgerTx.seq));
    if (txs.length === 0) return [];
    const postings = await db
      .select(postingColumns)
      .from(ledgerPosting)
      .where(inArray(ledgerPosting.txSeq, txs.map((t) => t.seq)))
      .orderBy(asc(ledgerPosting.id));
    return txs.map((t) => hydrate(t, postings.filter((p) => p.txSeq === t.seq)));
  },

  async checkIntegrity(): Promise<IntegrityIssue[]> {
    // ledger_check_balances() is defined in migration 001 (Drizzle does not model functions).
    const r = await db.execute<{ account: string; stored_cents: string; derived_cents: string }>(sql`SELECT * FROM ledger_check_balances()`);
    return r.rows.map((x) => ({ account: x.account, stored: toSafeInt(x.stored_cents), derived: toSafeInt(x.derived_cents) }));
  },
});
