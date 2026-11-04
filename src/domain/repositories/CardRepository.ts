import type { Card } from "../types/Entities.js";

/** app_card: each user's one Miden card and its limits. */
export interface CardRepository {
  findByUser(userId: string): Promise<Card | undefined>;
  /** Records the user's card; a second card for the same user is ignored (one card per user). */
  createIfAbsent(card: { cardId: string; userId: string; customerId: string; perTxnCents: number; dailyCents: number }): Promise<void>;
  userIdOf(cardId: string): Promise<string | undefined>;
  /** Whether the card's owner pays with one-time cards (privacy mode). */
  ownerHasPrivacyMode(cardId: string): Promise<boolean>;
  /** Every card with its owner's tier. */
  allWithTier(): Promise<{ cardId: string; tier: string }[]>;
}
