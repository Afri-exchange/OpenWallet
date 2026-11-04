import { customType, timestamp } from "drizzle-orm/pg-core";

/** Postgres BIGINT read as a JS number, refusing (never rounding) anything outside the safe integer range. */
export function toSafeInt(v: string | number | bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`value outside safe integer range: ${v}`);
  return n;
}

/**
 * BIGINT columns: amounts in cents, ledger seqs, nonces. Drizzle's own `bigint({ mode: "number" })` would silently
 * round past 2^53; this one throws instead, so a corrupted amount can never be read as a slightly different one.
 */
export const bigintNumber = customType<{ data: number; driverData: string }>({
  dataType: () => "bigint",
  toDriver: (v) => String(toSafeInt(v)),
  fromDriver: (v) => toSafeInt(v),
});

/** TIMESTAMPTZ as a JS Date. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** BYTEA as a Node Buffer (card vault ciphertext). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
