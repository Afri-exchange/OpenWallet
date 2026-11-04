import { sql } from "drizzle-orm";
import { bigserial, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { bytea, timestamptz } from "./columns.js";

// Card vault (migrations 008, 011): full card details AES-256-GCM sealed by the app (the key never reaches the
// database). last4 is kept in the clear for matching and display.

export const cardVault = pgTable(
  "card_vault",
  {
    cardId: text("card_id").primaryKey(),
    keyId: text("key_id").notNull(),
    iv: bytea("iv").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    tag: bytea("tag").notNull(),
    last4: text("last4").notNull(),
    source: text("source", { enum: ["issue", "full-pan"] }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("card_vault_source_check", sql`${t.source} IN ('issue', 'full-pan')`)],
);

export const VAULT_AUDIT_ACTIONS = ["put", "overwrite", "reveal", "reveal_miss", "discard"] as const;

/** One row per put, reveal attempt (including misses) and discard. Append-only by convention. */
export const cardVaultAudit = pgTable(
  "card_vault_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cardId: text("card_id").notNull(),
    action: text("action", { enum: VAULT_AUDIT_ACTIONS }).notNull(),
    purpose: text("purpose").notNull(),
    at: timestamptz("at").notNull().defaultNow(),
  },
  (t) => [
    index("card_vault_audit_card").on(t.cardId, t.at),
    check("card_vault_audit_action_check", sql`${t.action} IN ('put', 'overwrite', 'reveal', 'reveal_miss', 'discard')`),
  ],
);
