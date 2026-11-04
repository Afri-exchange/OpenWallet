import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PayoutRepository } from "../../domain/repositories/PayoutRepository.js";
import type { Database } from "../client.js";
import { appPayout } from "../schema/index.js";

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
});
