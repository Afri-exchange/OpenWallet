import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgTable, primaryKey, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { bigintNumber, timestamptz } from "./columns.js";
import { appDeveloper } from "./developers.js";

// Cardholder state (migrations 003, 010, 011): users, their one card, agents, spends, card fundings, one-time cards.
// Tokens are stored only as SHA-256 hashes. KYC identity data is never stored (it goes straight to Miden).

export const appUser = pgTable(
  "app_user",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique("app_user_email_key"),
    tokenHash: text("token_hash").notNull().unique("app_user_token_hash_key"),
    tier: text("tier", { enum: ["quick", "full"] }).notNull().default("quick"),
    kycReference: text("kyc_reference").unique("app_user_kyc_reference_key"),
    kycStatus: text("kyc_status").notNull().default("none"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    developerId: text("developer_id"),
    /** The developer's own id for the user. */
    externalId: text("external_id"),
    /** Each payment uses a fresh one-time card. Fixed when the user is created, never flipped. */
    privacyMode: boolean("privacy_mode").notNull().default(false),
  },
  (t) => [
    check("app_user_tier_check", sql`${t.tier} IN ('quick', 'full')`),
    foreignKey({ name: "app_user_developer_id_fkey", columns: [t.developerId], foreignColumns: [appDeveloper.id] }),
    uniqueIndex("app_user_developer_external").on(t.developerId, t.externalId).where(sql`${t.developerId} IS NOT NULL`),
  ],
);

/** One real card per user (Miden caps a customer at 3). */
export const appCard = pgTable(
  "app_card",
  {
  cardId: text("card_id").primaryKey(),
  userId: text("user_id").notNull().unique("app_card_user_id_key"),
  customerId: text("customer_id").notNull(),
  lastFour: text("last_four"),
  perTxnCents: bigintNumber("per_txn_cents").notNull(),
  dailyCents: bigintNumber("daily_cents").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [foreignKey({ name: "app_card_user_id_fkey", columns: [t.userId], foreignColumns: [appUser.id] })],
);

export const appAgent = pgTable(
  "app_agent",
  {
    cardId: text("card_id").notNull(),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique("app_agent_token_hash_key"),
    perTxnCents: bigintNumber("per_txn_cents").notNull(),
    dailyCents: bigintNumber("daily_cents").notNull(),
    allowedMccs: text("allowed_mccs").array(),
    revokedAt: timestamptz("revoked_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "app_agent_pkey", columns: [t.cardId, t.agentId] }),
    foreignKey({ name: "app_agent_card_id_fkey", columns: [t.cardId], foreignColumns: [appCard.cardId] }),
  ],
);

export const SPEND_STATUSES = ["processing", "approved", "declined", "voided"] as const;
export type SpendStatus = (typeof SPEND_STATUSES)[number];

/** Every payment attempt by an agent. idempotency_key is the agent's own key, scoped to the agent. */
export const appSpend = pgTable(
  "app_spend",
  {
    spendId: text("spend_id").primaryKey(),
    cardId: text("card_id").notNull(),
    agentId: text("agent_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountCents: bigintNumber("amount_cents").notNull(),
    merchant: text("merchant").notNull(),
    mcc: text("mcc"),
    status: text("status", { enum: SPEND_STATUSES }).notNull(),
    reason: text("reason"),
    ledgerSeq: bigintNumber("ledger_seq"),
    midenAuthId: text("miden_auth_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** The card actually charged, when it is not the user's own card (privacy mode). */
    chargeCardId: text("charge_card_id"),
  },
  (t) => [
    unique("app_spend_card_id_agent_id_idempotency_key_key").on(t.cardId, t.agentId, t.idempotencyKey),
    foreignKey({ name: "app_spend_card_id_agent_id_fkey", columns: [t.cardId, t.agentId], foreignColumns: [appAgent.cardId, appAgent.agentId] }),
    check("app_spend_amount_cents_check", sql`${t.amountCents} > 0`),
    check("app_spend_status_check", sql`${t.status} IN ('processing', 'approved', 'declined', 'voided')`),
  ],
);

export const FUNDING_STATUSES = ["reserved", "completed", "released"] as const;

/** Moving credited stablecoin onto the Miden card (holding -> pending -> card). */
export const appFunding = pgTable(
  "app_funding",
  {
    fundingId: text("funding_id").primaryKey(),
    cardId: text("card_id").notNull(),
    amountCents: bigintNumber("amount_cents").notNull(),
    status: text("status", { enum: FUNDING_STATUSES }).notNull(),
    detail: text("detail"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "app_funding_card_id_fkey", columns: [t.cardId], foreignColumns: [appCard.cardId] }),
    check("app_funding_amount_cents_check", sql`${t.amountCents} > 0`),
    check("app_funding_status_check", sql`${t.status} IN ('reserved', 'completed', 'released')`),
  ],
);

export const ONE_TIME_CARD_STATUSES = ["issuing", "ready", "failed", "needs_review"] as const;

/**
 * One row per one-time card, written BEFORE the issue call so a crash mid-issue is visible. 'issuing': the request
 * may be in flight or lost; 'ready': issued; 'failed': Miden refused it; 'needs_review': a person must look.
 */
export const appOneTimeCard = pgTable(
  "app_one_time_card",
  {
    oneTimeId: text("one_time_id").primaryKey(),
    userId: text("user_id").notNull(),
    spendId: text("spend_id").notNull().unique("app_one_time_card_spend_id_key"),
    cardId: text("card_id").unique("app_one_time_card_card_id_key"),
    amountCents: bigintNumber("amount_cents").notNull(),
    status: text("status", { enum: ONE_TIME_CARD_STATUSES }).notNull(),
    detail: text("detail"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "app_one_time_card_user_id_fkey", columns: [t.userId], foreignColumns: [appUser.id] }),
    check("app_one_time_card_amount_cents_check", sql`${t.amountCents} > 0`),
    check("app_one_time_card_status_check", sql`${t.status} IN ('issuing', 'ready', 'failed', 'needs_review')`),
  ],
);
