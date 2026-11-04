import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { CheckoutRepository } from "../../domain/repositories/CheckoutRepository.js";
import { isUniqueViolation, type Database } from "../client.js";
import { appCheckout, appSpend } from "../schema/index.js";

const byAttempt = (checkoutId: string, attempt: number) => and(eq(appCheckout.checkoutId, checkoutId), eq(appCheckout.attempt, attempt));

export const createCheckoutRepository = (db: Database): CheckoutRepository => ({
  async find(checkoutId) {
    const [row] = await db.select().from(appCheckout).where(eq(appCheckout.checkoutId, checkoutId));
    return row;
  },

  async findByIdempotencyKey(merchantId, idempotencyKey) {
    const [row] = await db
      .select()
      .from(appCheckout)
      .where(and(eq(appCheckout.merchantId, merchantId), eq(appCheckout.idempotencyKey, idempotencyKey)));
    return row;
  },

  listByMerchant(merchantId, limit) {
    return db.select().from(appCheckout).where(eq(appCheckout.merchantId, merchantId)).orderBy(desc(appCheckout.createdAt)).limit(limit);
  },

  async createOpen(c) {
    try {
      const [row] = await db.insert(appCheckout).values({ ...c, status: "open" }).returning();
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) return undefined;
      throw e;
    }
  },

  async cancelIfOpen(checkoutId, merchantId) {
    const [row] = await db
      .update(appCheckout)
      .set({ status: "canceled", updatedAt: sql`now()` })
      .where(and(eq(appCheckout.checkoutId, checkoutId), eq(appCheckout.merchantId, merchantId), eq(appCheckout.status, "open")))
      .returning();
    return row;
  },

  async expireOpen(now) {
    await db
      .update(appCheckout)
      .set({ status: "expired", updatedAt: sql`now()` })
      .where(and(eq(appCheckout.status, "open"), lte(appCheckout.expiresAt, now)));
  },

  async claim(checkoutId, agent, now) {
    const [row] = await db
      .update(appCheckout)
      .set({
        status: "processing",
        cardId: agent.cardId,
        agentId: agent.agentId,
        attempt: sql`${appCheckout.attempt} + 1`,
        claimedAt: now,
        spendId: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(appCheckout.checkoutId, checkoutId), eq(appCheckout.status, "open"), gt(appCheckout.expiresAt, now)))
      .returning();
    return row;
  },

  async markPaid(checkoutId, attempt, spendId, paidAt) {
    const [row] = await db
      .update(appCheckout)
      .set({ status: "paid", spendId, paidAt, lastError: null, updatedAt: sql`now()` })
      .where(and(byAttempt(checkoutId, attempt), eq(appCheckout.status, "processing")))
      .returning();
    return row;
  },

  async attachSpend(checkoutId, attempt, spendId) {
    const [row] = await db
      .update(appCheckout)
      .set({ spendId, updatedAt: sql`now()` })
      .where(and(byAttempt(checkoutId, attempt), eq(appCheckout.status, "processing")))
      .returning();
    return row;
  },

  async release(checkoutId, attempt, why) {
    const [row] = await db
      .update(appCheckout)
      .set({ status: "open", cardId: null, agentId: null, spendId: null, claimedAt: null, lastError: why, updatedAt: sql`now()` })
      .where(and(byAttempt(checkoutId, attempt), eq(appCheckout.status, "processing")))
      .returning();
    return row;
  },

  async flagForReview(checkoutId, note, attempt) {
    await db
      .update(appCheckout)
      .set({ needsReview: note, updatedAt: sql`now()` })
      .where(attempt === undefined ? eq(appCheckout.checkoutId, checkoutId) : byAttempt(checkoutId, attempt));
  },

  async recordSettlement(checkoutId, ledgerSeq) {
    const [row] = await db
      .update(appCheckout)
      .set({ settledSeq: ledgerSeq, updatedAt: sql`now()` })
      .where(and(eq(appCheckout.checkoutId, checkoutId), eq(appCheckout.status, "paid")))
      .returning();
    return row;
  },

  async findProcessingIds(limit) {
    const rows = await db
      .select({ checkoutId: appCheckout.checkoutId })
      .from(appCheckout)
      .where(eq(appCheckout.status, "processing"))
      .orderBy(asc(appCheckout.claimedAt))
      .limit(limit);
    return rows.map((r) => r.checkoutId);
  },

  findUnsettled(limit) {
    return db
      .select()
      .from(appCheckout)
      .where(and(eq(appCheckout.status, "paid"), isNull(appCheckout.settledSeq)))
      .orderBy(asc(appCheckout.paidAt))
      .limit(limit);
  },

  async findSpendByKey(cardId, agentId, idempotencyKey) {
    const [row] = await db
      .select()
      .from(appSpend)
      .where(and(eq(appSpend.cardId, cardId), eq(appSpend.agentId, agentId), eq(appSpend.idempotencyKey, idempotencyKey)));
    return row;
  },

  async findSpend(spendId) {
    const [row] = await db.select().from(appSpend).where(eq(appSpend.spendId, spendId));
    return row;
  },
});
