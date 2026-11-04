import { drizzle, type NodePgDatabase, type NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type pg from "pg";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;
/** The application's database handle. Only repositories (src/db/repositories) use it. */
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool };
export type Transaction = NodePgTransaction<Schema, ExtractTablesWithRelations<Schema>>;
/** Anything a query can run on: the pool-backed database or an open transaction. */
export type Executor = NodePgDatabase<Schema> | Transaction;

export function createDatabase(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}

/** Postgres error codes the repositories translate into domain outcomes. */
export const PgCode = { uniqueViolation: "23505", checkViolation: "23514" } as const;

/** The driver error behind a Drizzle query error (Drizzle wraps it in `cause`). */
export function pgError(e: unknown): { code?: string; constraint?: string } | undefined {
  for (let cur: unknown = e, i = 0; cur && i < 4; cur = (cur as { cause?: unknown }).cause, i++) {
    if (typeof (cur as { code?: unknown }).code === "string") return cur as { code?: string; constraint?: string };
  }
  return undefined;
}

export const isUniqueViolation = (e: unknown, constraint?: string) => {
  const err = pgError(e);
  return err?.code === PgCode.uniqueViolation && (constraint === undefined || err.constraint === constraint);
};
