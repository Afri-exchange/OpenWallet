import type pg from "pg";
import type { CursorStore, DepositAddresses } from "./base-usdc-watcher.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Postgres cursor (table chain_cursor, migration 002). Run PgStore.migrate() first. */
export class PgCursor implements CursorStore {
  constructor(private readonly pool: pg.Pool, private readonly name: string) {}

  async get(): Promise<number | undefined> {
    const r = await this.pool.query<{ block: string }>("SELECT block FROM chain_cursor WHERE name = $1", [this.name]);
    if (!r.rows[0]) return undefined;
    const n = Number(r.rows[0].block);
    if (!Number.isSafeInteger(n)) throw new Error(`cursor ${this.name} out of range: ${r.rows[0].block}`);
    return n;
  }

  /** Only moves forward, so two watchers racing on one name cannot rewind each other. */
  async set(block: number): Promise<void> {
    if (!Number.isSafeInteger(block) || block < 0) throw new Error("block must be a non-negative integer");
    await this.pool.query(
      `INSERT INTO chain_cursor (name, block) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET block = GREATEST(chain_cursor.block, EXCLUDED.block), updated_at = now()`,
      [this.name, block],
    );
  }
}

/** Deposit addresses in Postgres (table deposit_address, migration 002). One address funds exactly one card. */
export class PgDepositAddresses implements DepositAddresses {
  constructor(private readonly pool: pg.Pool, private readonly chain = "base") {}

  /** Records an address for a card. Re-adding the same pair is a no-op; moving it to another card is refused. */
  async add(address: string, cardId: string): Promise<void> {
    const a = address.toLowerCase();
    if (!ADDRESS.test(a)) throw new Error("address must be 0x + 40 hex characters");
    if (!cardId.trim()) throw new Error("cardId is required: a deposit address without a card is no use");
    await this.pool.query(
      "INSERT INTO deposit_address (chain, address, card_id) VALUES ($1, $2, $3) ON CONFLICT (chain, address) DO NOTHING",
      [this.chain, a, cardId],
    );
    const owner = await this.cardFor(a);
    if (owner !== cardId) throw new Error(`address ${a} already belongs to card ${owner}`);
  }

  async all(): Promise<string[]> {
    return (await this.pool.query<{ address: string }>("SELECT address FROM deposit_address WHERE chain = $1", [this.chain])).rows.map((r) => r.address);
  }

  async cardFor(address: string): Promise<string | undefined> {
    const r = await this.pool.query<{ card_id: string }>(
      "SELECT card_id FROM deposit_address WHERE chain = $1 AND address = $2",
      [this.chain, address.toLowerCase()],
    );
    return r.rows[0]?.card_id;
  }
}
