import type { LedgerTransaction } from "../../lib/services/Ledger.js";

/** What a store needs to persist; seq is assigned by the store. */
export type NewStoredTransaction = Omit<LedgerTransaction, "seq">;

/** Thrown by append when the idempotency key (or a reversal target) already exists. */
export class DuplicateKeyError extends Error {}

/** Operations valid inside one store transaction. */
export interface StoreTx {
  /**
   * Locks the accounts' balance rows (in a stable order, so concurrent writers cannot deadlock)
   * and returns their current balances. Anything the caller decides from these balances stays
   * true until the transaction ends.
   */
  lock(accounts: string[]): Promise<Map<string, number>>;
  findByKey(idempotencyKey: string): Promise<LedgerTransaction | undefined>;
  findBySeq(seq: number): Promise<LedgerTransaction | undefined>;
  /** Appends the transaction, assigns seq and applies its postings to the balances. */
  append(tx: NewStoredTransaction): Promise<LedgerTransaction>;
}

export interface LedgerStore {
  /** Runs fn as one atomic unit. If fn throws, nothing it appended is kept. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  balance(account: string): Promise<number>;
  history(account: string): Promise<LedgerTransaction[]>;
}
