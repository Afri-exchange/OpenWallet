import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { migrate } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";

// The Drizzle schema (src/db/schema) must describe exactly what the SQL migrations build. This builds two throwaway
// databases, one from the migrations and one from the DDL drizzle-kit generates for the schema, and compares their
// catalogs: every column (type, nullability, default), constraint (definition) and index (definition) must match.
// Triggers and functions exist only in the migrations (Drizzle does not model them) and are not compared.
// Runs only with DATABASE_URL (it needs CREATEDB on that server).
const databaseUrl = process.env.DATABASE_URL;

async function catalog(pool: pg.Pool) {
  const q = async (sql: string) => (await pool.query(sql)).rows.map((r) => Object.values(r).join(" | ")).sort();
  return {
    columns: await q(`SELECT table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default, '') FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'ledger_migrations'`),
    constraints: await q(`SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> 'ledger_migrations'`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'ledger_migrations'`),
    sequences: await q(`SELECT sequence_name, start_value, minimum_value FROM information_schema.sequences WHERE sequence_schema = 'public'`),
  };
}

test("the Drizzle schema matches the migrated database exactly", { skip: !databaseUrl }, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const names = ["migrated", "drizzle"].map((k) => `agent_cards_${k}_${randomBytes(4).toString("hex")}`);
  const pools: pg.Pool[] = [];
  after(async () => {
    for (const p of pools) await p.end();
    for (const n of names) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
    await admin.end();
  });
  for (const n of names) {
    await admin.query(`CREATE DATABASE ${n}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${n}`;
    pools.push(new pg.Pool({ connectionString: url.toString(), max: 2 }));
  }
  const [migrated, fromSchema] = pools as [pg.Pool, pg.Pool];

  await migrate(migrated);
  const empty = generateDrizzleJson({});
  const ddl = await generateMigration(empty, generateDrizzleJson(schema));
  for (const statement of ddl) await fromSchema.query(statement);

  const [a, b] = [await catalog(migrated), await catalog(fromSchema)];
  for (const part of ["columns", "constraints", "indexes", "sequences"] as const) {
    assert.deepEqual(b[part], a[part], `src/db/schema ${part} differ from src/db/migrations`);
  }
});
