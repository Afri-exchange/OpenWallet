import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PgLedgerStore } from "../src/db/repositories/PgLedgerStore.js";
import { PgCursor, PgDepositAddresses } from "../src/db/repositories/PgChainRepositories.js";

// Runs only with DATABASE_URL, like test/ledger.test.ts. Each case gets its own schema.
const databaseUrl = process.env.DATABASE_URL;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const pools: pg.Pool[] = [];
const schemas: string[] = [];

async function fresh(): Promise<pg.Pool> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
  pools.push(pool);
  await new PgLedgerStore(pool).migrate();
  return pool;
}

after(async () => {
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

const A = "0x00000000000000000000000000000000000000AA";

test("cursor starts empty, persists, and never moves backwards", { skip: !databaseUrl }, async () => {
  const pool = await fresh();
  const c = new PgCursor(pool, "base:usdc");
  assert.equal(await c.get(), undefined);
  await c.set(100);
  await c.set(90);
  assert.equal(await new PgCursor(pool, "base:usdc").get(), 100);
  assert.equal(await new PgCursor(pool, "other").get(), undefined);
});

test("deposit addresses: case-insensitive, idempotent, one card per address", { skip: !databaseUrl }, async () => {
  const pool = await fresh();
  const d = new PgDepositAddresses(pool);
  await d.add(A, "card-1");
  await d.add(A.toLowerCase(), "card-1");
  await assert.rejects(d.add(A, "card-2"), /already belongs to card card-1/);
  await assert.rejects(d.add(A, " "), /without a card/);
  await assert.rejects(d.add("0x123", "card-1"), /40 hex/);
  assert.deepEqual(await d.all(), [A.toLowerCase()]);
  assert.equal(await d.cardFor(A), "card-1");
  assert.equal(await new PgDepositAddresses(pool, "ethereum").cardFor(A), undefined);
});
