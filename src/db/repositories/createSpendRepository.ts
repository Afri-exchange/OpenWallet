import { and, asc, desc, eq, gte, inArray, isNull, lt, not, sql, type SQL } from "drizzle-orm";
import type { SpendRepository } from "../../domain/repositories/SpendRepository.js";
import { isUniqueViolation, type Database, type Executor } from "../client.js";
import { appCard, appSpend } from "../schema/index.js";
import { toSafeInt } from "../schema/columns.js";

/** Spends that hold money: approved, or still processing (held until the card's answer is known). */
const holdsMoney = inArray(appSpend.status, ["approved", "processing"]);

/** COALESCE(sum(amount_cents), 0) as a safe JS number. */
const sumAmount = () => sql`COALESCE(sum(${appSpend.amountCents}), 0)`.mapWith(toSafeInt);

async function sumWhere(q: Executor, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ s: sumAmount() }).from(appSpend).where(where);
  return row!.s;
}

const agentWindow = (cardId: string, agentId: string, start: Date, end: Date) =>
  and(eq(appSpend.cardId, cardId), eq(appSpend.agentId, agentId), holdsMoney, gte(appSpend.createdAt, start), lt(appSpend.createdAt, end));

export const createSpendRepository = (db: Database): SpendRepository => ({
  async find(spendId) {
    const [row] = await db.select().from(appSpend).where(eq(appSpend.spendId, spendId));
    return row;
  },

  async findWithOwner(spendId) {
    const [row] = await db
      .select({ spend: appSpend, userId: appCard.userId })
      .from(appSpend)
      .innerJoin(appCard, eq(appCard.cardId, appSpend.cardId))
      .where(eq(appSpend.spendId, spendId));
    return row ? { ...row.spend, userId: row.userId } : undefined;
  },

  async findByKey(cardId, agentId, idempotencyKey) {
    const [row] = await db
      .select()
      .from(appSpend)
      .where(and(eq(appSpend.cardId, cardId), eq(appSpend.agentId, agentId), eq(appSpend.idempotencyKey, idempotencyKey)));
    return row;
  },

  recentByAgent(cardId, agentId, limit) {
    return db
      .select()
      .from(appSpend)
      .where(and(eq(appSpend.cardId, cardId), eq(appSpend.agentId, agentId)))
      .orderBy(desc(appSpend.createdAt))
      .limit(limit);
  },

  heldSince(since) {
    return db
      .select({ spendId: appSpend.spendId, cardId: appSpend.cardId, agentId: appSpend.agentId, amountCents: appSpend.amountCents, createdAt: appSpend.createdAt })
      .from(appSpend)
      .where(and(holdsMoney, gte(appSpend.createdAt, since)));
  },

  agentSpentBetween(cardId, agentId, start, end) {
    return sumWhere(db, agentWindow(cardId, agentId, start, end));
  },

  async open(draft, [start, end], decide) {
    try {
      return await db.transaction(async (tx) => {
        // The card row lock serialises every payment on the card, in any process, so two cannot both fit a limit.
        const [card] = await tx.select({ dailyCents: appCard.dailyCents }).from(appCard).where(eq(appCard.cardId, draft.cardId)).for("update");
        if (!card) return { outcome: "card_not_found" as const };
        const cardSpentCents = await sumWhere(tx, and(eq(appSpend.cardId, draft.cardId), holdsMoney, gte(appSpend.createdAt, start), lt(appSpend.createdAt, end)));
        const agentSpentCents = await sumWhere(tx, agentWindow(draft.cardId, draft.agentId, start, end));
        const reason = decide({ cardDailyCents: card.dailyCents, cardSpentCents, agentSpentCents });
        const [spend] = await tx
          .insert(appSpend)
          .values({ ...draft, status: reason ? "declined" : "processing", reason })
          .returning();
        return { outcome: "opened" as const, spend: spend! };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { outcome: "duplicate_key" };
      throw e;
    }
  },

  async finish(spendId, status, reason, extra = {}) {
    const [row] = await db
      .update(appSpend)
      .set({
        status,
        reason,
        ...(extra.seq !== undefined ? { ledgerSeq: extra.seq } : {}),
        ...(extra.auth !== undefined ? { midenAuthId: extra.auth } : {}),
      })
      .where(eq(appSpend.spendId, spendId))
      .returning();
    return row;
  },

  async setLedgerSeqIfProcessing(spendId, seq) {
    const r = await db
      .update(appSpend)
      .set({ ledgerSeq: seq })
      .where(and(eq(appSpend.spendId, spendId), eq(appSpend.status, "processing")))
      .returning({ spendId: appSpend.spendId });
    return r.length > 0;
  },

  async setChargeCard(spendId, chargeCardId) {
    await db.update(appSpend).set({ chargeCardId }).where(eq(appSpend.spendId, spendId));
  },

  processingBefore(before, excludeKeyPrefix, limit) {
    return db
      .select()
      .from(appSpend)
      .where(and(eq(appSpend.status, "processing"), lt(appSpend.createdAt, before), not(sql`starts_with(${appSpend.idempotencyKey}, ${excludeKeyPrefix})`)))
      .orderBy(asc(appSpend.createdAt))
      .limit(limit);
  },

  async settleProcessing(spendId, status, reason, auth) {
    const r = await db
      .update(appSpend)
      .set({ status, reason, ...(auth !== undefined ? { midenAuthId: auth } : {}) })
      .where(and(eq(appSpend.spendId, spendId), eq(appSpend.status, "processing")))
      .returning({ spendId: appSpend.spendId });
    return r.length === 1;
  },

  async voidUndebited(spendId, reason) {
    await db
      .update(appSpend)
      .set({ status: "voided", reason })
      .where(and(eq(appSpend.spendId, spendId), eq(appSpend.status, "processing"), isNull(appSpend.ledgerSeq)));
  },

  async noteProcessing(spendId, reason) {
    await db
      .update(appSpend)
      .set({ reason })
      .where(and(eq(appSpend.spendId, spendId), eq(appSpend.status, "processing")));
  },
});
