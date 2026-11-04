import type { LedgerTransaction } from "../../lib/services/Ledger.js";
import { DuplicateKeyError, type LedgerStore, type NewStoredTransaction, type StoreTx } from "../../domain/repositories/LedgerStore.js";

/** In-process store for unit tests. Transactions are serialised, so lock() needs no row locks. */
export class MemoryLedgerStore implements LedgerStore {
  private readonly txs: LedgerTransaction[] = [];
  private readonly byKey = new Map<string, LedgerTransaction>();
  private readonly reversed = new Set<number>();
  private readonly balances = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(this.view()));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async balance(account: string): Promise<number> {
    return this.balances.get(account) ?? 0;
  }

  async history(account: string): Promise<LedgerTransaction[]> {
    return this.txs.filter((t) => t.postings.some((p) => p.account === account));
  }

  private view(): StoreTx {
    return {
      lock: async (accounts) => new Map(accounts.map((a) => [a, this.balances.get(a) ?? 0])),
      findByKey: async (key) => this.byKey.get(key),
      findBySeq: async (seq) => this.txs[seq - 1],
      append: async (tx) => {
        if (this.byKey.has(tx.idempotencyKey)) throw new DuplicateKeyError(tx.idempotencyKey);
        if (tx.reversesSeq !== undefined && this.reversed.has(tx.reversesSeq)) throw new DuplicateKeyError(`reversal of ${tx.reversesSeq}`);
        const stored: LedgerTransaction = { seq: this.txs.length + 1, ...tx };
        this.txs.push(stored);
        this.byKey.set(tx.idempotencyKey, stored);
        if (tx.reversesSeq !== undefined) this.reversed.add(tx.reversesSeq);
        for (const p of tx.postings) this.balances.set(p.account, (this.balances.get(p.account) ?? 0) + p.amountCents);
        return stored;
      },
    };
  }
}
