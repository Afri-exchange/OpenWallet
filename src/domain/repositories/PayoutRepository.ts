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
}
