import type { Checkout, Spend } from "../types/Entities.js";

/**
 * app_checkout: merchant checkouts paid by agents. Status moves open -> processing -> paid, or open -> canceled |
 * expired; every transition is a conditional update that returns the row only if it applied.
 */
export interface CheckoutRepository {
  find(checkoutId: string): Promise<Checkout | undefined>;
  findByIdempotencyKey(merchantId: string, idempotencyKey: string): Promise<Checkout | undefined>;
  /** Newest first, up to `limit`. */
  listByMerchant(merchantId: string, limit: number): Promise<Checkout[]>;
  /** Inserts an open checkout. Undefined if a unique constraint (e.g. the merchant's idempotency key) is already taken. */
  createOpen(c: {
    checkoutId: string;
    merchantId: string;
    amountCents: number;
    description: string;
    reference: string | null;
    mcc: string | null;
    metadata: Record<string, unknown> | null;
    idempotencyKey: string | null;
    expiresAt: Date;
  }): Promise<Checkout | undefined>;
  /** open -> canceled, for this merchant's checkout. */
  cancelIfOpen(checkoutId: string, merchantId: string): Promise<Checkout | undefined>;
  /** Open checkouts whose expiry is at or before `now` become expired. */
  expireOpen(now: Date): Promise<void>;
  /** open (and unexpired at `now`) -> processing for this agent, as a new attempt with no spend yet. */
  claim(checkoutId: string, agent: { cardId: string; agentId: string }, now: Date): Promise<Checkout | undefined>;
  /** processing -> paid, for this attempt only. */
  markPaid(checkoutId: string, attempt: number, spendId: string, paidAt: Date): Promise<Checkout | undefined>;
  /** Records the attempt's spend while it is still processing. */
  attachSpend(checkoutId: string, attempt: number, spendId: string): Promise<Checkout | undefined>;
  /** processing -> open for another attempt, clearing the claim; `why` is kept as last_error. */
  release(checkoutId: string, attempt: number, why: string): Promise<Checkout | undefined>;
  /** Sets needs_review; when `attempt` is given, only if the checkout is still on that attempt. */
  flagForReview(checkoutId: string, note: string, attempt?: number): Promise<void>;
  /** Records the ledger entry that credited the merchant for a paid checkout. */
  recordSettlement(checkoutId: string, ledgerSeq: number): Promise<Checkout | undefined>;
  /** Ids of processing checkouts, oldest claim first. */
  findProcessingIds(limit: number): Promise<string[]>;
  /** Paid checkouts with no settlement entry yet, oldest payment first. */
  findUnsettled(limit: number): Promise<Checkout[]>;
  /** The agent payment made under a checkout attempt's spend key (read-only view of app_spend). */
  findSpendByKey(cardId: string, agentId: string, idempotencyKey: string): Promise<Spend | undefined>;
  findSpend(spendId: string): Promise<Spend | undefined>;
}
