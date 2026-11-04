import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { CursorStore } from "../../adapters/deposits/BaseUsdcWatcher.js";
import type { DepositAddressRepository } from "../../domain/repositories/DepositAddressRepository.js";
import type { Database, Executor } from "../client.js";
import { chainCursor, depositAddress } from "../schema/index.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** A watcher's block cursor (table chain_cursor). */
export const createCursorStore = (db: Database, name: string): CursorStore => ({
  async get() {
    const [row] = await db.select({ block: chainCursor.block }).from(chainCursor).where(eq(chainCursor.name, name));
    return row?.block;
  },

  /** Only moves forward, so two watchers racing on one name cannot rewind each other. */
  async set(block) {
    if (!Number.isSafeInteger(block) || block < 0) throw new Error("block must be a non-negative integer");
    await db
      .insert(chainCursor)
      .values({ name, block })
      .onConflictDoUpdate({
        target: chainCursor.name,
        set: { block: sql`GREATEST(${chainCursor.block}, excluded.block)`, updatedAt: sql`now()` },
      });
  },
});

async function cardFor(q: Executor, chain: string, address: string): Promise<string | undefined> {
  const [row] = await q
    .select({ cardId: depositAddress.cardId })
    .from(depositAddress)
    .where(and(eq(depositAddress.chain, chain), eq(depositAddress.address, address.toLowerCase())));
  return row?.cardId;
}

async function add(q: Executor, chain: string, address: string, cardId: string): Promise<void> {
  const a = address.toLowerCase();
  if (!ADDRESS.test(a)) throw new Error("address must be 0x + 40 hex characters");
  if (!cardId.trim()) throw new Error("cardId is required: a deposit address without a card is no use");
  await q.insert(depositAddress).values({ chain, address: a, cardId }).onConflictDoNothing({ target: [depositAddress.chain, depositAddress.address] });
  const owner = await cardFor(q, chain, a);
  if (owner !== cardId) throw new Error(`address ${a} already belongs to card ${owner}`);
}

/** Deposit addresses (table deposit_address) on one chain. One address funds exactly one card. */
export const createDepositAddressRepository = (db: Database, chain = "base"): DepositAddressRepository => ({
  add: (address, cardId) => add(db, chain, address, cardId),

  async all() {
    return (await db.select({ address: depositAddress.address }).from(depositAddress).where(eq(depositAddress.chain, chain))).map((r) => r.address);
  },

  cardFor: (address) => cardFor(db, chain, address),

  async issuedAddressOf(cardId) {
    const [row] = await db
      .select({ address: depositAddress.address })
      .from(depositAddress)
      .where(and(eq(depositAddress.cardId, cardId), isNotNull(depositAddress.derivationIndex)))
      .orderBy(asc(depositAddress.derivationIndex))
      .limit(1);
    return row?.address;
  },

  async nextDerivationIndex() {
    // A sequence call; Drizzle has no builder for nextval().
    const r = await db.execute<{ i: string }>(sql`SELECT nextval('deposit_derivation_seq') AS i`);
    const i = Number(r.rows[0]!.i);
    if (!Number.isSafeInteger(i)) throw new Error(`derivation index out of range: ${r.rows[0]!.i}`);
    return i;
  },

  async assign(address, cardId, derivationIndex) {
    const a = address.toLowerCase();
    await db.transaction(async (tx) => {
      await add(tx, chain, a, cardId);
      // As before the refactor: the index is recorded on every chain's row for this address.
      await tx.update(depositAddress).set({ derivationIndex }).where(eq(depositAddress.address, a));
    });
  },
});
