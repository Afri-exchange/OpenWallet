import type { OneTimeCard } from "../types/Entities.js";
import type { InsertOutcome } from "./UserRepository.js";

export type OneTimeCardStatus = OneTimeCard["status"];

/** app_one_time_card: privacy-mode one-time cards, one per spend. */
export interface OneTimeCardRepository {
  findBySpend(spendId: string): Promise<OneTimeCard | undefined>;
  /** One-time cards the user started in the last 24 hours (database clock). */
  countStartedInLastDay(userId: string): Promise<number>;
  /** Writes the 'issuing' row before the issue call; 'duplicate' if the spend already has one. */
  start(row: { oneTimeId: string; userId: string; spendId: string; amountCents: number }): Promise<InsertOutcome>;
  /** Sets status and detail; the card id only fills in when given. */
  mark(oneTimeId: string, status: OneTimeCardStatus, detail: string | null, cardId?: string): Promise<void>;
}
