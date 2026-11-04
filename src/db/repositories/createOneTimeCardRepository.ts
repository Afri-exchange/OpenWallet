import { and, count, eq, gt, sql } from "drizzle-orm";
import type { OneTimeCardRepository } from "../../domain/repositories/OneTimeCardRepository.js";
import { isUniqueViolation, type Database } from "../client.js";
import { appOneTimeCard } from "../schema/index.js";

export const createOneTimeCardRepository = (db: Database): OneTimeCardRepository => ({
  async findBySpend(spendId) {
    const [row] = await db.select().from(appOneTimeCard).where(eq(appOneTimeCard.spendId, spendId));
    return row;
  },

  async countStartedInLastDay(userId) {
    const [row] = await db
      .select({ n: count() })
      .from(appOneTimeCard)
      .where(and(eq(appOneTimeCard.userId, userId), gt(appOneTimeCard.createdAt, sql`now() - interval '24 hours'`)));
    return row!.n;
  },

  async start(row) {
    try {
      await db.insert(appOneTimeCard).values({ ...row, status: "issuing" });
      return "created";
    } catch (e) {
      // A concurrent attempt for the same spend won the unique index.
      if (isUniqueViolation(e)) return "duplicate";
      throw e;
    }
  },

  async mark(oneTimeId, status, detail, cardId) {
    await db
      .update(appOneTimeCard)
      .set({ status, detail, ...(cardId !== undefined ? { cardId } : {}), updatedAt: sql`now()` })
      .where(eq(appOneTimeCard.oneTimeId, oneTimeId));
  },
});
