import type { Spend, SpendStatus } from "../types/Entities.js";

/** The fields of a new spend; status and reason come from the limit check in `open`. */
export interface SpendDraft {
  spendId: string;
  cardId: string;
  agentId: string;
  idempotencyKey: string;
  amountCents: number;
  merchant: string;
  mcc: string | null;
}

/** What `open` reads under the card's row lock, for the caller to decide a decline reason. */
export interface DailyTotals {
  cardDailyCents: number;
  /** Approved and processing spends on the card in the window. */
  cardSpentCents: number;
  /** Approved and processing spends by this agent in the window. */
  agentSpentCents: number;
}

export type OpenSpendResult =
  | { outcome: "opened"; spend: Spend }
  | { outcome: "card_not_found" }
  /** Another attempt already holds this (card, agent, idempotency key). */
  | { outcome: "duplicate_key" };

/** app_spend: every payment attempt by an agent. */
export interface SpendRepository {
  find(spendId: string): Promise<Spend | undefined>;
  findWithOwner(spendId: string): Promise<(Spend & { userId: string }) | undefined>;
  findByKey(cardId: string, agentId: string, idempotencyKey: string): Promise<Spend | undefined>;
  /** Most recent first. */
  recentByAgent(cardId: string, agentId: string, limit: number): Promise<Spend[]>;
  /** Approved and processing spends created at or after `since` (they hold money in the agent wallets). */
  heldSince(since: Date): Promise<Pick<Spend, "spendId" | "cardId" | "agentId" | "amountCents" | "createdAt">[]>;
  /** Sum of the agent's approved and processing spends created in [start, end). */
  agentSpentBetween(cardId: string, agentId: string, start: Date, end: Date): Promise<number>;
  /**
   * In one transaction: locks the card row, sums the window's card and agent spends, asks `decide` for a decline
   * reason (null = within limits) and inserts the spend as processing, or declined with that reason.
   */
  open(draft: SpendDraft, window: [Date, Date], decide: (t: DailyTotals) => string | null): Promise<OpenSpendResult>;
  /** Sets the outcome unconditionally; seq and auth only fill in when given. */
  finish(spendId: string, status: SpendStatus, reason: string | null, extra?: { seq?: number; auth?: string }): Promise<Spend | undefined>;
  /** Records the ledger debit on a processing spend. False if it is no longer processing. */
  setLedgerSeqIfProcessing(spendId: string, seq: number): Promise<boolean>;
  setChargeCard(spendId: string, chargeCardId: string): Promise<void>;
  /** Processing spends created before `before`, excluding keys starting with `excludeKeyPrefix`, oldest first. */
  processingBefore(before: Date, excludeKeyPrefix: string, limit: number): Promise<Spend[]>;
  /** Moves a processing spend to `status` (auth fills in when given). True if this call moved it. */
  settleProcessing(spendId: string, status: SpendStatus, reason: string | null, auth?: string): Promise<boolean>;
  /** Voids a processing spend that never got a ledger debit (ledger_seq still null). */
  voidUndebited(spendId: string, reason: string): Promise<void>;
  /** Replaces the reason on a processing spend. */
  noteProcessing(spendId: string, reason: string): Promise<void>;
}
