import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.js";

/**
 * Postgres advisory lock keys. Each only needs to be distinct; they are listed here so two features can never pick
 * the same one by accident.
 */
export const AdvisoryLock = {
  /** src/db/migrate.ts: one migrator at a time. */
  migrator: 727401,
  /** PayoutInteractor: one payout sender across processes. */
  payoutSender: 727402,
} as const;

/**
 * Runs `fn` while holding a session-level advisory lock on one dedicated connection, or returns `undefined` at once if
 * another process holds it. The lock is released (and the connection returned) however `fn` ends.
 */
export async function withTryAdvisoryLock<T>(db: Database, key: number, fn: () => Promise<T>): Promise<T | undefined> {
  const client = await db.$client.connect();
  try {
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]);
    if (!r.rows[0]?.ok) return undefined;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    }
  } finally {
    client.release();
  }
}

/** Takes a transaction-scoped advisory lock on a text key (released at commit or rollback). */
export async function advisoryXactLock(tx: Transaction, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}
