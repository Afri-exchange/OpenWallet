import { eq } from "drizzle-orm";
import type { CardRepository } from "../../domain/repositories/CardRepository.js";
import type { Database } from "../client.js";
import { appCard, appUser } from "../schema/index.js";

export const createCardRepository = (db: Database): CardRepository => ({
  async findByUser(userId) {
    const [row] = await db.select().from(appCard).where(eq(appCard.userId, userId));
    return row;
  },

  async createIfAbsent(card) {
    await db.insert(appCard).values(card).onConflictDoNothing({ target: appCard.userId });
  },

  async userIdOf(cardId) {
    const [row] = await db.select({ userId: appCard.userId }).from(appCard).where(eq(appCard.cardId, cardId));
    return row?.userId;
  },

  async ownerHasPrivacyMode(cardId) {
    const [row] = await db
      .select({ privacyMode: appUser.privacyMode })
      .from(appCard)
      .innerJoin(appUser, eq(appUser.id, appCard.userId))
      .where(eq(appCard.cardId, cardId));
    return row?.privacyMode === true;
  },

  allWithTier() {
    return db.select({ cardId: appCard.cardId, tier: appUser.tier }).from(appCard).innerJoin(appUser, eq(appUser.id, appCard.userId));
  },
});
