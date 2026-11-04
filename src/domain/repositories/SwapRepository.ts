import type { CheckoutSwap, NewCheckoutSwap, Spend, SwapStatus } from "../types/Entities.js";

/** What the swap interactor needs to know about the spend behind a swap. */
export type SwapSpendSummary = Pick<Spend, "spendId" | "status" | "reason">;

/** app_checkout_swap: agents paying third-party hosted checkouts (plus the reads of app_spend, app_card, app_user they need). */
export interface SwapRepository {
  /**
   * Check-and-insert, atomic per card and amount (transaction-scoped advisory lock). Busy means: no row yet under this
   * card, agent and idempotency key, and another swap on the card for the same amount, created since `busySince`, is
   * still unsettled (open, a challenge whose spend is processing, or paid but unmatched and not under review). The check
   * is skipped when `skipBusyCheck()` says so (privacy mode). Not busy: inserts the swap as 'pending', keeping an
   * existing row under the same key as is. Returns false when busy; nothing was written then.
   */
  insertUnlessBusy(
    swap: Omit<NewCheckoutSwap, "status">,
    opts: { busySince: Date; skipBusyCheck: () => Promise<boolean> },
  ): Promise<boolean>;
  findByKey(cardId: string, agentId: string, idempotencyKey: string): Promise<CheckoutSwap | undefined>;
  findForAgent(swapId: string, cardId: string, agentId: string): Promise<CheckoutSwap | undefined>;
  /** Newest first. */
  listForAgent(cardId: string, agentId: string, limit: number): Promise<CheckoutSwap[]>;
  /** The browser is about to (or may) have the card: status 'filling', tied to its spend. */
  markFilling(swapId: string, spendId: string): Promise<void>;
  setChargeCard(swapId: string, chargeCardId: string): Promise<void>;
  recordFill(swapId: string, fill: { outcome: string; detail: string | null; submitted: boolean }): Promise<void>;
  /** 'failed' with a detail, only while still pending or filling. */
  failIfOpen(swapId: string, detail: string): Promise<void>;
  /**
   * The final write after pay(): status and spend, the detail if one is given (else kept), and `cardTxnRef` when given
   * and the status is 'paid'. Returns the updated row.
   */
  finish(swapId: string, out: { status: SwapStatus; spendId: string; detail?: string; cardTxnRefIfPaid?: string }): Promise<CheckoutSwap>;
  /** Sets status, and the detail if one is given (else kept). */
  setStatus(swapId: string, status: SwapStatus, detail?: string): Promise<void>;
  /** Swaps whose charge state is still open (a challenge only while its spend is processing), untouched since `before`. Oldest first. */
  openForReconcile(before: Date, limit: number): Promise<CheckoutSwap[]>;
  /** Paid on the page but not yet matched to a card transaction or flagged, untouched since `before`. Oldest first. */
  paidUnconfirmed(before: Date, limit: number): Promise<CheckoutSwap[]>;
  /** Card transaction refs already claimed by swaps on this card. */
  claimedTxnRefs(cardId: string): Promise<Set<string>>;
  /**
   * Another unmatched, unsettled swap on the same card for the same amount, created within [from, to], that a card
   * transaction could also belong to.
   */
  hasRival(swap: Pick<CheckoutSwap, "swapId" | "cardId" | "amountCents">, window: { from: Date; to: Date }): Promise<boolean>;
  /** Claims a card transaction for a swap (card_txn_ref is unique) and records its MCC; keeps an existing review note. True if claimed. */
  claimCardTxn(swapId: string, txnRef: string, cardMcc: string | null, reviewNote: string | null): Promise<boolean>;
  /** Sets review unless it is already set. */
  flagForReview(swapId: string, note: string): Promise<void>;
  /** The agent's spend under an idempotency key. */
  findSpend(cardId: string, agentId: string, idempotencyKey: string): Promise<Spend | undefined>;
  spendSummary(spendId: string): Promise<SwapSpendSummary | undefined>;
  /** The email of the user who owns the card. */
  ownerEmail(cardId: string): Promise<string | undefined>;
}
