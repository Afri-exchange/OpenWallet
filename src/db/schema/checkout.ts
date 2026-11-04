import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { bigintNumber, timestamptz } from "./columns.js";
import { appAgent, appSpend } from "./cardholders.js";

// Checkouts (migrations 004-007, 009). A merchant fixes the price and an agent pays it with its owner's card.

export const appMerchant = pgTable(
  "app_merchant",
  {
    merchantId: text("merchant_id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique("app_merchant_email_key"),
    /** Default merchant category for its checkouts (agents' MCC allowlists apply to it). */
    mcc: text("mcc"),
    keyHash: text("key_hash").notNull().unique("app_merchant_key_hash_key"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    payoutAddress: text("payout_address"),
    /** Payouts to a newly set address wait until the change is old enough (account-takeover delay). */
    payoutAddressSetAt: timestamptz("payout_address_set_at"),
  },
  (t) => [
    check("app_merchant_mcc_check", sql`${t.mcc} ~ '^\\d{4}$'`),
    check("app_merchant_payout_address_check", sql`${t.payoutAddress} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

export const CHECKOUT_STATUSES = ["open", "processing", "paid", "canceled", "expired"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const appCheckout = pgTable(
  "app_checkout",
  {
    checkoutId: text("checkout_id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    amountCents: bigintNumber("amount_cents").notNull(),
    description: text("description").notNull(),
    /** The merchant's own order id, echoed back. */
    reference: text("reference"),
    mcc: text("mcc"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key"),
    status: text("status", { enum: CHECKOUT_STATUSES }).notNull(),
    /** The agent holding the claim (processing) or that paid (paid). Cleared when an attempt fails. */
    cardId: text("card_id"),
    agentId: text("agent_id"),
    /** Each claim is a new attempt with its own spend idempotency key: checkout:<id>:<attempt>. */
    attempt: integer("attempt").notNull().default(0),
    claimedAt: timestamptz("claimed_at"),
    spendId: text("spend_id").unique("app_checkout_spend_id_key"),
    /** Internal only (the payer's limits are private); merchants see lastAttempt = "failed". */
    lastError: text("last_error"),
    /** Set when a person must look. */
    needsReview: text("needs_review"),
    expiresAt: timestamptz("expires_at").notNull(),
    paidAt: timestamptz("paid_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    /** The ledger seq that credited the merchant. A paid checkout with none is settled by sync(). */
    settledSeq: bigintNumber("settled_seq"),
  },
  (t) => [
    unique("app_checkout_merchant_id_idempotency_key_key").on(t.merchantId, t.idempotencyKey),
    foreignKey({ name: "app_checkout_merchant_id_fkey", columns: [t.merchantId], foreignColumns: [appMerchant.merchantId] }),
    foreignKey({ name: "app_checkout_spend_id_fkey", columns: [t.spendId], foreignColumns: [appSpend.spendId] }),
    index("app_checkout_merchant").on(t.merchantId, t.createdAt.desc().nullsFirst()),
    index("app_checkout_processing").on(t.claimedAt).where(sql`${t.status} = 'processing'`),
    index("app_checkout_unsettled").on(t.paidAt).where(sql`${t.status} = 'paid' AND ${t.settledSeq} IS NULL`),
    check("app_checkout_amount_cents_check", sql`${t.amountCents} > 0`),
    check("app_checkout_mcc_check", sql`${t.mcc} ~ '^\\d{4}$'`),
    check("app_checkout_status_check", sql`${t.status} IN ('open', 'processing', 'paid', 'canceled', 'expired')`),
    check("app_checkout_check", sql`(${t.status} IN ('processing', 'paid')) = (${t.agentId} IS NOT NULL)`),
  ],
);

export const PAYOUT_STATUSES = ["requested", "sending", "sent", "failed"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * requested: reserved in the ledger, not yet sent. sending: signed and stored (raw_tx) before broadcast, settled from
 * the chain by its hash. sent: confirmed. failed: definitely refused; the money went back to the balance.
 */
export const appPayout = pgTable(
  "app_payout",
  {
    payoutId: text("payout_id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    amountCents: bigintNumber("amount_cents").notNull(),
    status: text("status", { enum: PAYOUT_STATUSES }).notNull(),
    idempotencyKey: text("idempotency_key"),
    /** The rail's id for the transfer (the transaction hash). */
    railReference: text("rail_reference"),
    failure: text("failure"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    /** The address snapshot the payout was requested to, so a later change cannot redirect it. */
    destination: text("destination"),
    chain: text("chain"),
    rawTx: text("raw_tx"),
    nonce: bigintNumber("nonce"),
    /** Why a requested payout has not gone out yet; internal. */
    lastError: text("last_error"),
    /** Set when a person must look. The money stays reserved. */
    needsReview: text("needs_review"),
    /** Signing failures while the payout account was funded; after a few, the payout fails and is released. */
    signFailures: integer("sign_failures").notNull().default(0),
  },
  (t) => [
    unique("app_payout_merchant_id_idempotency_key_key").on(t.merchantId, t.idempotencyKey),
    foreignKey({ name: "app_payout_merchant_id_fkey", columns: [t.merchantId], foreignColumns: [appMerchant.merchantId] }),
    index("app_payout_merchant").on(t.merchantId, t.createdAt.desc().nullsFirst()),
    uniqueIndex("app_payout_rail_reference").on(t.railReference).where(sql`${t.railReference} IS NOT NULL`),
    /** One transfer in flight at a time keeps nonces in order. */
    uniqueIndex("app_payout_one_sending").on(sql`(true)`).where(sql`${t.status} = 'sending'`),
    index("app_payout_queue").on(t.createdAt).where(sql`${t.status} = 'requested'`),
    check("app_payout_amount_cents_check", sql`${t.amountCents} > 0`),
    check("app_payout_status_check", sql`${t.status} IN ('requested', 'sending', 'sent', 'failed')`),
    check("app_payout_destination_check", sql`${t.destination} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

export const SWAP_STATUSES = ["pending", "filling", "processing", "paid", "failed", "challenge", "needs_review"] as const;
export type SwapStatus = (typeof SWAP_STATUSES)[number];

/**
 * Checkout swap: an agent pays a third-party hosted checkout, which our server fills with the owner's vaulted card.
 * The money moves through app_spend under checkout:swap:<swap_id>.
 */
export const appCheckoutSwap = pgTable(
  "app_checkout_swap",
  {
    swapId: text("swap_id").primaryKey(),
    cardId: text("card_id").notNull(),
    agentId: text("agent_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    checkoutUrl: text("checkout_url").notNull(),
    checkoutHost: text("checkout_host").notNull(),
    amountCents: bigintNumber("amount_cents").notNull(),
    merchant: text("merchant").notNull(),
    mcc: text("mcc"),
    status: text("status", { enum: SWAP_STATUSES }).notNull(),
    /** What the filler reported: succeeded, declined, amount_mismatch, captcha, three_ds, unsupported_page, error. */
    outcome: text("outcome"),
    /** Short, card-free description of what happened. */
    detail: text("detail"),
    /** Whether the card form was submitted: false means this attempt cannot have charged the card. */
    submitted: boolean("submitted").notNull().default(false),
    spendId: text("spend_id"),
    /** The card network's Authorization matched to this swap; one transaction pays one swap. */
    cardTxnRef: text("card_txn_ref").unique("app_checkout_swap_card_txn_ref_key"),
    /** The merchant category the card network saw. */
    cardMcc: text("card_mcc"),
    /** Set when a person should look at an otherwise settled swap. */
    review: text("review"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    chargeCardId: text("charge_card_id"),
  },
  (t) => [
    unique("app_checkout_swap_card_id_agent_id_idempotency_key_key").on(t.cardId, t.agentId, t.idempotencyKey),
    foreignKey({ name: "app_checkout_swap_card_id_agent_id_fkey", columns: [t.cardId, t.agentId], foreignColumns: [appAgent.cardId, appAgent.agentId] }),
    index("app_checkout_swap_unconfirmed").on(t.createdAt).where(sql`${t.status} = 'paid' AND ${t.cardTxnRef} IS NULL AND ${t.review} IS NULL`),
    index("app_checkout_swap_open").on(t.status, t.createdAt).where(sql`${t.status} IN ('filling', 'processing', 'challenge')`),
    check("app_checkout_swap_amount_cents_check", sql`${t.amountCents} > 0`),
    check("app_checkout_swap_mcc_check", sql`${t.mcc} ~ '^\\d{4}$'`),
    check(
      "app_checkout_swap_status_check",
      sql`${t.status} IN ('pending', 'filling', 'processing', 'paid', 'failed', 'challenge', 'needs_review')`,
    ),
  ],
);
