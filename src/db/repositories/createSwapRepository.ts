import { and, asc, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, lte, ne, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { SwapRepository } from "../../domain/repositories/SwapRepository.js";
import type { Database } from "../client.js";
import { advisoryXactLock } from "../locks.js";
import { appCard, appCheckoutSwap as swap, appSpend, appUser } from "../schema/index.js";

const now = sql`now()`;

/** A challenge stays open only while its spend's money is held (the spend is joined as appSpend). */
const challengeHeld = and(eq(swap.status, "challenge"), eq(appSpend.status, "processing"));

export const createSwapRepository = (db: Database): SwapRepository => ({
  async insertUnlessBusy(row, opts) {
    return db.transaction(async (tx) => {
      await advisoryXactLock(tx, `swap:${row.cardId}:${row.amountCents}`);
      if (!(await opts.skipBusyCheck())) {
        const own = alias(swap, "k");
        const [busy] = await tx
          .select({ one: sql`1` })
          .from(swap)
          .leftJoin(appSpend, eq(appSpend.spendId, swap.spendId))
          .where(
            and(
              eq(swap.cardId, row.cardId),
              eq(swap.amountCents, row.amountCents),
              not(and(eq(swap.agentId, row.agentId), eq(swap.idempotencyKey, row.idempotencyKey))!),
              gte(swap.createdAt, opts.busySince),
              or(
                inArray(swap.status, ["pending", "filling", "processing"]),
                challengeHeld,
                and(eq(swap.status, "paid"), isNull(swap.cardTxnRef), isNull(swap.review)),
              ),
              not(
                exists(
                  tx
                    .select({ one: sql`1` })
                    .from(own)
                    .where(and(eq(own.cardId, row.cardId), eq(own.agentId, row.agentId), eq(own.idempotencyKey, row.idempotencyKey))),
                ),
              ),
            ),
          )
          .limit(1);
        if (busy) return false;
      }
      await tx
        .insert(swap)
        .values({ ...row, status: "pending" })
        .onConflictDoNothing({ target: [swap.cardId, swap.agentId, swap.idempotencyKey] });
      return true;
    });
  },

  async findByKey(cardId, agentId, idempotencyKey) {
    const [row] = await db.select().from(swap).where(and(eq(swap.cardId, cardId), eq(swap.agentId, agentId), eq(swap.idempotencyKey, idempotencyKey)));
    return row;
  },

  async findForAgent(swapId, cardId, agentId) {
    const [row] = await db.select().from(swap).where(and(eq(swap.swapId, swapId), eq(swap.cardId, cardId), eq(swap.agentId, agentId)));
    return row;
  },

  listForAgent(cardId, agentId, limit) {
    return db.select().from(swap).where(and(eq(swap.cardId, cardId), eq(swap.agentId, agentId))).orderBy(desc(swap.createdAt)).limit(limit);
  },

  async markFilling(swapId, spendId) {
    await db.update(swap).set({ status: "filling", spendId, updatedAt: now }).where(eq(swap.swapId, swapId));
  },

  async setChargeCard(swapId, chargeCardId) {
    await db.update(swap).set({ chargeCardId, updatedAt: now }).where(eq(swap.swapId, swapId));
  },

  async recordFill(swapId, fill) {
    await db.update(swap).set({ outcome: fill.outcome, detail: fill.detail, submitted: fill.submitted, updatedAt: now }).where(eq(swap.swapId, swapId));
  },

  async failIfOpen(swapId, detail) {
    await db
      .update(swap)
      .set({ status: "failed", detail, updatedAt: now })
      .where(and(eq(swap.swapId, swapId), inArray(swap.status, ["pending", "filling"])));
  },

  async finish(swapId, out) {
    const [row] = await db
      .update(swap)
      .set({
        status: out.status,
        spendId: out.spendId,
        ...(out.detail !== undefined ? { detail: out.detail } : {}),
        ...(out.cardTxnRefIfPaid !== undefined && out.status === "paid" ? { cardTxnRef: out.cardTxnRefIfPaid } : {}),
        updatedAt: now,
      })
      .where(eq(swap.swapId, swapId))
      .returning();
    return row!;
  },

  async setStatus(swapId, status, detail) {
    await db
      .update(swap)
      .set({ status, ...(detail !== undefined ? { detail } : {}), updatedAt: now })
      .where(eq(swap.swapId, swapId));
  },

  async openForReconcile(before, limit) {
    const rows = await db
      .select({ swap })
      .from(swap)
      .leftJoin(appSpend, eq(appSpend.spendId, swap.spendId))
      .where(and(or(inArray(swap.status, ["pending", "filling", "processing"]), challengeHeld), lt(swap.updatedAt, before)))
      .orderBy(asc(swap.createdAt))
      .limit(limit);
    return rows.map((r) => r.swap);
  },

  paidUnconfirmed(before, limit) {
    return db
      .select()
      .from(swap)
      .where(and(eq(swap.status, "paid"), isNull(swap.cardTxnRef), isNull(swap.review), lt(swap.updatedAt, before)))
      .orderBy(asc(swap.createdAt))
      .limit(limit);
  },

  async claimedTxnRefs(cardId) {
    const rows = await db.select({ ref: swap.cardTxnRef }).from(swap).where(and(eq(swap.cardId, cardId), isNotNull(swap.cardTxnRef)));
    return new Set(rows.map((r) => r.ref!));
  },

  async hasRival(s, window) {
    const [row] = await db
      .select({ one: sql`1` })
      .from(swap)
      .leftJoin(appSpend, eq(appSpend.spendId, swap.spendId))
      .where(
        and(
          eq(swap.cardId, s.cardId),
          ne(swap.swapId, s.swapId),
          eq(swap.amountCents, s.amountCents),
          isNull(swap.cardTxnRef),
          or(inArray(swap.status, ["pending", "filling", "processing", "paid", "needs_review"]), challengeHeld),
          lte(swap.createdAt, window.to),
          gte(swap.createdAt, window.from),
        ),
      )
      .limit(1);
    return row !== undefined;
  },

  async claimCardTxn(swapId, txnRef, cardMcc, reviewNote) {
    const r = await db
      .update(swap)
      .set({ cardTxnRef: txnRef, cardMcc, review: sql`COALESCE(${swap.review}, ${reviewNote})`, updatedAt: now })
      .where(and(eq(swap.swapId, swapId), isNull(swap.cardTxnRef)))
      .returning({ swapId: swap.swapId });
    return r.length === 1;
  },

  async flagForReview(swapId, note) {
    await db.update(swap).set({ review: note, updatedAt: now }).where(and(eq(swap.swapId, swapId), isNull(swap.review)));
  },

  async findSpend(cardId, agentId, idempotencyKey) {
    const [row] = await db
      .select()
      .from(appSpend)
      .where(and(eq(appSpend.cardId, cardId), eq(appSpend.agentId, agentId), eq(appSpend.idempotencyKey, idempotencyKey)));
    return row;
  },

  async spendSummary(spendId) {
    const [row] = await db
      .select({ spendId: appSpend.spendId, status: appSpend.status, reason: appSpend.reason })
      .from(appSpend)
      .where(eq(appSpend.spendId, spendId));
    return row;
  },

  async ownerEmail(cardId) {
    const [row] = await db.select({ email: appUser.email }).from(appCard).innerJoin(appUser, eq(appUser.id, appCard.userId)).where(eq(appCard.cardId, cardId));
    return row?.email;
  },
});
