import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { AdvisoryLock } from "./locks.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
/** See src/db/locks.ts. */
export const MIGRATOR_LOCK = AdvisoryLock.migrator;

/**
 * Applies any src/db/migrations/*.sql not yet recorded in ledger_migrations, each in its own transaction, one migrator
 * at a time across processes. Safe to call on every boot.
 *
 * Migrations are reviewed SQL, not generated: they carry what Drizzle cannot model (the ledger's append-only triggers,
 * ledger_check_balances()). The Drizzle schema in src/db/schema must match them; test/db-schema.test.ts enforces it.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATOR_LOCK]);
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
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATOR_LOCK]).catch(() => undefined);
    client.release();
  }
}
