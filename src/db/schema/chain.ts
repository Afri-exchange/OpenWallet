import { sql } from "drizzle-orm";
import { check, index, integer, pgSequence, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { bigintNumber, timestamptz } from "./columns.js";

/** Deposit addresses we issued (migrations 002, 003). Each funds exactly one card. */
export const depositAddress = pgTable(
  "deposit_address",
  {
    chain: text("chain").notNull(),
    /** Lower-case 0x-prefixed hex, 20 bytes. */
    address: text("address").notNull(),
    cardId: text("card_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** HD derivation index, so the key can be re-derived from the mnemonic. */
    derivationIndex: integer("derivation_index").unique("deposit_address_derivation_index_key"),
  },
  (t) => [
    primaryKey({ name: "deposit_address_pkey", columns: [t.chain, t.address] }),
    index("deposit_address_card").on(t.cardId),
    check("deposit_address_chain_check", sql`${t.chain} <> ''`),
    check("deposit_address_address_check", sql`${t.address} ~ '^0x[0-9a-f]{40}$'`),
    check("deposit_address_card_id_check", sql`${t.cardId} <> ''`),
  ],
);

export const depositDerivationSeq = pgSequence("deposit_derivation_seq", { startWith: 0, minValue: 0 });

/** Last block fully credited, per watcher (e.g. 'base:usdc'). */
export const chainCursor = pgTable(
  "chain_cursor",
  {
    name: text("name").primaryKey(),
    block: bigintNumber("block").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("chain_cursor_name_check", sql`${t.name} <> ''`), check("chain_cursor_block_check", sql`${t.block} >= 0`)],
);
