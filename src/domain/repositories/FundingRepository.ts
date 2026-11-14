import type { Funding } from "../types/Entities.js";

export type FundingStatus = Funding["status"];

/** app_funding: top-ups moving credited deposits onto the Miden card. */
export interface FundingRepository {
  /** Writes a 'reserved' row, before the ledger reserve and the Miden call. */
  create(funding: { fundingId: string; cardId: string; amountCents: number }): Promise<void>;
  setStatus(fundingId: string, status: FundingStatus, detail: string | null): Promise<void>;
  /** Reserved top-ups, oldest first. */
  reserved(): Promise<Pick<Funding, "fundingId" | "cardId" | "amountCents" | "createdAt">[]>;
  /** The card's most recent top-ups, newest first. */
  recentByCard(cardId: string, limit: number): Promise<Funding[]>;
  /** Reserved plus completed top-ups on the card (counts against the tier's lifetime cap). */
  committedCents(cardId: string): Promise<number>;
}
