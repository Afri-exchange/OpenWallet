import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { LedgerTransaction, Posting } from "./ledger.js";
import { DuplicateKeyError, type LedgerStore, type NewStoredTransaction, type StoreTx } from "./store.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

interface TxRow { seq: string; idempotency_key: string; kind: string; reference: string | null; reverses_seq: string | null; created_at: Date }
interface PostingRow { tx_seq: string; account: string; amount_cents: string }

/** Raised for a Postgres CHECK violation on ledger_balance, i.e. a non-negative account would go below zero. */
export class OverdraftError extends Error {}

function toSafeInt(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`value outside safe integer range: ${v}`);
  return n;
}

function hydrate(r: TxRow, postings: PostingRow[]): LedgerTransaction {
  const tx: LedgerTransaction = {
    seq: toSafeInt(r.seq),
    idempotencyKey: r.idempotency_key,
    kind: r.kind,
    postings: postings.map((p): Posting => ({ account: p.account, amountCents: toSafeInt(p.amount_cents) })),
    createdAt: r.created_at.toISOString(),
  };
  if (r.reference !== null) tx.reference = r.reference;
  if (r.reverses_seq !== null) tx.reversesSeq = toSafeInt(r.reverses_seq);
  return tx;
}

async function load(q: pg.Pool | pg.PoolClient, where: string, param: unknown): Promise<LedgerTransaction | undefined> {
  const t = await q.query<TxRow>(`SELECT * FROM ledger_tx WHERE ${where}`, [param]);
  const row = t.rows[0];
  if (!row) return undefined;
  const p = await q.query<PostingRow>("SELECT tx_seq, account, amount_cents FROM ledger_posting WHERE tx_seq = $1 ORDER BY id", [row.seq]);
  return hydrate(row, p.rows);
}

/**
 * Postgres store. Each transaction runs at READ COMMITTED but takes row locks on the balance rows of
 * every account it touches before reading them, so concurrent reserves/spends on one account queue up
 * and the second one sees the first one's committed balance. The CHECK on ledger_balance backstops it.
 */
export class PgStore implements LedgerStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(connectionString: string): PgStore {
    return new PgStore(new pg.Pool({ connectionString }));
  }

  /** Applies any migrations/*.sql not yet recorded in ledger_migrations. Safe to call on every boot. */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // One migrator at a time across processes.
      await client.query("SELECT pg_advisory_lock(727401)");
      await client.query("CREATE TABLE IF NOT EXISTS ledger_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const done = new Set((await client.query<{ name: string }>("SELECT name FROM ledger_migrations")).rows.map((r) => r.name));
      for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(file)) continue;
        await client.query("BEGIN");
        try {
          await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
          await client.query("INSERT INTO ledger_migrations (name) VALUES ($1)", [file]);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(727401)").catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(this.view(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapError(e);
    } finally {
      client.release();
    }
  }

  async balance(account: string): Promise<number> {
    const r = await this.pool.query<{ balance_cents: string }>("SELECT balance_cents FROM ledger_balance WHERE account = $1", [account]);
    return r.rows[0] ? toSafeInt(r.rows[0].balance_cents) : 0;
  }

  async history(account: string): Promise<LedgerTransaction[]> {
    const t = await this.pool.query<TxRow>(
      "SELECT * FROM ledger_tx WHERE seq IN (SELECT tx_seq FROM ledger_posting WHERE account = $1) ORDER BY seq",
      [account],
    );
    if (t.rows.length === 0) return [];
    const p = await this.pool.query<PostingRow>(
      "SELECT tx_seq, account, amount_cents FROM ledger_posting WHERE tx_seq = ANY($1::bigint[]) ORDER BY id",
      [t.rows.map((r) => r.seq)],
    );
    return t.rows.map((r) => hydrate(r, p.rows.filter((x) => x.tx_seq === r.seq)));
  }

  /** Accounts whose stored balance disagrees with their postings, plus '' if the grand total is not zero. */
  async checkIntegrity(): Promise<{ account: string; stored: number; derived: number }[]> {
    const r = await this.pool.query<{ account: string; stored_cents: string; derived_cents: string }>("SELECT * FROM ledger_check_balances()");
    return r.rows.map((x) => ({ account: x.account, stored: toSafeInt(x.stored_cents), derived: toSafeInt(x.derived_cents) }));
  }

  private view(c: pg.PoolClient): StoreTx {
    return {
      lock: async (accounts) => {
        const sorted = [...new Set(accounts)].sort();
        if (sorted.length === 0) return new Map();
        await c.query("INSERT INTO ledger_balance (account) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [sorted]);
        const r = await c.query<{ account: string; balance_cents: string }>(
          "SELECT account, balance_cents FROM ledger_balance WHERE account = ANY($1::text[]) ORDER BY account FOR UPDATE",
          [sorted],
        );
        return new Map(r.rows.map((x) => [x.account, toSafeInt(x.balance_cents)]));
      },
      findByKey: (key) => load(c, "idempotency_key = $1", key),
      findBySeq: (seq) => load(c, "seq = $1", seq),
      append: async (tx: NewStoredTransaction) => {
        const ins = await c.query<{ seq: string }>(
          "INSERT INTO ledger_tx (idempotency_key, kind, reference, reverses_seq, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING seq",
          [tx.idempotencyKey, tx.kind, tx.reference ?? null, tx.reversesSeq ?? null, tx.createdAt],
        );
        const seq = ins.rows[0]!.seq;
        await c.query(
          "INSERT INTO ledger_posting (tx_seq, account, amount_cents) SELECT $1, a, m FROM unnest($2::text[], $3::bigint[]) AS u(a, m)",
          [seq, tx.postings.map((p) => p.account), tx.postings.map((p) => String(p.amountCents))],
        );
        // Callers lock() every touched account first, so these rows exist and are ours.
        const net = new Map<string, number>();
        for (const p of tx.postings) net.set(p.account, (net.get(p.account) ?? 0) + p.amountCents);
        for (const [account, d] of [...net].sort(([a], [b]) => (a < b ? -1 : 1))) {
          await c.query("UPDATE ledger_balance SET balance_cents = balance_cents + $2 WHERE account = $1", [account, String(d)]);
        }
        return { seq: toSafeInt(seq), ...tx };
      },
    };
  }
}

function mapError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string };
  if (err?.code === "23505") return new DuplicateKeyError(err.constraint ?? "duplicate key");
  if (err?.code === "23514" && err.constraint === "ledger_balance_no_overdraft") return new OverdraftError("insufficient funds");
  return e;
}
