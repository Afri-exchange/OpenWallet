import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import type { PayoutRepository } from "../../domain/repositories/PayoutRepository.js";
import { isUniqueViolation, type Database } from "../client.js";
import { appPayout, ledgerTx } from "../schema/index.js";

export const createPayoutRepository = (db: Database): PayoutRepository => ({
  async findSending() {
    const [row] = await db.select().from(appPayout).where(eq(appPayout.status, "sending"));
    return row;
  },

  requestedQueue(chain, limit) {
    return db
      .select()
      .from(appPayout)
      .where(and(eq(appPayout.status, "requested"), eq(appPayout.chain, chain)))
      .orderBy(asc(appPayout.createdAt))
      .limit(limit);
  },

  async flagForReview(payoutId, note) {
    const r = await db
      .update(appPayout)
      .set({ needsReview: note, updatedAt: sql`now()` })
      .where(and(eq(appPayout.payoutId, payoutId), isNull(appPayout.needsReview)))
      .returning({ payoutId: appPayout.payoutId });
    return r.length > 0;
  },

  async recordSignFailure(payoutId, error, counts) {
    const [row] = await db
      .update(appPayout)
      .set({ lastError: error, signFailures: sql`${appPayout.signFailures} + ${counts ? 1 : 0}`, updatedAt: sql`now()` })
      .where(and(eq(appPayout.payoutId, payoutId), eq(appPayout.status, "requested")))
      .returning({ signFailures: appPayout.signFailures });
    return row?.signFailures;
  },

  async markSending(payoutId, signed) {
    const r = await db
      .update(appPayout)
      .set({ status: "sending", railReference: signed.txHash, rawTx: signed.rawTx, nonce: signed.nonce, lastError: null, updatedAt: sql`now()` })
      .where(and(eq(appPayout.payoutId, payoutId), eq(appPayout.status, "requested")))
      .returning({ payoutId: appPayout.payoutId });
    return r.length > 0;
  },

  async find(payoutId) {
    const [row] = await db.select().from(appPayout).where(eq(appPayout.payoutId, payoutId));
    return row;
  },

  async findByIdempotencyKey(merchantId, idempotencyKey) {
    const [row] = await db.select().from(appPayout).where(and(eq(appPayout.merchantId, merchantId), eq(appPayout.idempotencyKey, idempotencyKey)));
    return row;
  },

  listByMerchant(merchantId, limit) {
    return db.select().from(appPayout).where(eq(appPayout.merchantId, merchantId)).orderBy(desc(appPayout.createdAt)).limit(limit);
  },

  async createRequested(p) {
    try {
      await db.insert(appPayout).values({ ...p, status: "requested" });
      return true;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  },

  async failRequested(payoutId, failure) {
    await db
      .update(appPayout)
      .set({ status: "failed", failure, updatedAt: sql`now()` })
      .where(and(eq(appPayout.payoutId, payoutId), eq(appPayout.status, "requested")));
  },

  async claimSettlement(payoutId, from, outcome) {
    const fromState =
      from === "requested"
        ? eq(appPayout.status, "requested")
        : from === "sending"
          ? eq(appPayout.status, "sending")
          : and(eq(appPayout.status, "sending"), isNotNull(appPayout.needsReview));
    const set = outcome.sent
      ? // A missing rail reference keeps the one already stored.
        { status: "sent" as const, ...(outcome.railReference !== undefined ? { railReference: outcome.railReference } : {}), updatedAt: sql`now()` }
      : { status: "failed" as const, failure: outcome.failure, updatedAt: sql`now()` };
    const [row] = await db.update(appPayout).set(set).where(and(eq(appPayout.payoutId, payoutId), fromState)).returning();
    return row;
  },

  findUnfinishedSettlements(limit) {
    const entry = (prefix: string) => sql`${prefix} || ${appPayout.payoutId}`;
    return db
      .select()
      .from(appPayout)
      .where(
        and(
          inArray(appPayout.status, ["sent", "failed"]),
          exists(db.select({ one: sql`1` }).from(ledgerTx).where(eq(ledgerTx.idempotencyKey, entry("payout-reserve:")))),
          notExists(
            db
              .select({ one: sql`1` })
              .from(ledgerTx)
              .where(or(eq(ledgerTx.idempotencyKey, entry("payout-complete:")), eq(ledgerTx.idempotencyKey, entry("payout-release:")))),
          ),
        ),
      )
      .orderBy(asc(appPayout.updatedAt))
      .limit(limit);
  },
});
