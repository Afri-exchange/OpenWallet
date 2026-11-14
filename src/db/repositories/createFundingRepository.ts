import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FundingRepository } from "../../domain/repositories/FundingRepository.js";
import type { Database } from "../client.js";
import { appFunding } from "../schema/index.js";
import { toSafeInt } from "../schema/columns.js";

export const createFundingRepository = (db: Database): FundingRepository => ({
  async create(funding) {
    await db.insert(appFunding).values({ ...funding, status: "reserved" });
  },

  async setStatus(fundingId, status, detail) {
    await db.update(appFunding).set({ status, detail, updatedAt: sql`now()` }).where(eq(appFunding.fundingId, fundingId));
  },

  reserved() {
    return db
      .select({ fundingId: appFunding.fundingId, cardId: appFunding.cardId, amountCents: appFunding.amountCents, createdAt: appFunding.createdAt })
      .from(appFunding)
      .where(eq(appFunding.status, "reserved"))
      .orderBy(asc(appFunding.createdAt));
  },

  recentByCard(cardId, limit) {
    return db.select().from(appFunding).where(eq(appFunding.cardId, cardId)).orderBy(desc(appFunding.createdAt)).limit(limit);
  },

  async committedCents(cardId) {
    const [row] = await db
      .select({ s: sql`COALESCE(sum(${appFunding.amountCents}), 0)`.mapWith(toSafeInt) })
      .from(appFunding)
      .where(and(eq(appFunding.cardId, cardId), inArray(appFunding.status, ["reserved", "completed"])));
    return row!.s;
  },
});
