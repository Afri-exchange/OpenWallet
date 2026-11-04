import type { Payout } from "../types/Entities.js";

/** Merchant payouts (table app_payout). Status moves requested -> sending -> sent | failed. */
export interface PayoutRepository {
  /** The one payout in flight (status 'sending'), if any. */
  findSending(): Promise<Payout | undefined>;
  /** Oldest requested payouts on a chain, up to `limit`. */
  requestedQueue(chain: string, limit: number): Promise<Payout[]>;
  /** Sets needs_review unless it is already set. True if this call set it. */
  flagForReview(payoutId: string, note: string): Promise<boolean>;
  /**
   * Records a failed signing attempt on a still-requested payout; `counts` adds it to sign_failures. Returns the new
   * sign_failures, or undefined if the payout is no longer requested.
   */
  recordSignFailure(payoutId: string, error: string, counts: boolean): Promise<number | undefined>;
  /** requested -> sending with the signed bytes, stored before broadcast. False if it was no longer requested. */
  markSending(payoutId: string, signed: { txHash: string; rawTx: string; nonce: number }): Promise<boolean>;

  find(payoutId: string): Promise<Payout | undefined>;
  findByIdempotencyKey(merchantId: string, idempotencyKey: string): Promise<Payout | undefined>;
  /** Newest first, up to `limit`. */
  listByMerchant(merchantId: string, limit: number): Promise<Payout[]>;
  /** Inserts a requested payout. False if a unique constraint (e.g. the merchant's idempotency key) is already taken. */
  createRequested(p: { payoutId: string; merchantId: string; amountCents: number; idempotencyKey: string | null; destination: string; chain: string }): Promise<boolean>;
  /** requested -> failed (its reservation never happened). */
  failRequested(payoutId: string, failure: string): Promise<void>;
  /**
   * Claims a payout for its final status, only from `from`: 'requested' (ops, nothing broadcast), 'sending' (the
   * chain's answer) or 'sending-under-review' (a person, with needs_review set). Returns the claimed row, or
   * undefined if the payout was not in that state.
   */
  claimSettlement(
    payoutId: string,
    from: "requested" | "sending" | "sending-under-review",
    outcome: { sent: true; railReference?: string } | { sent: false; failure: string },
  ): Promise<Payout | undefined>;
  /**
   * Payouts marked sent or failed whose ledger step never landed: a payout-reserve:<id> ledger entry exists and no
   * payout-complete:<id> or payout-release:<id>. Least recently updated first.
   */
  findUnfinishedSettlements(limit: number): Promise<Payout[]>;
}
