import { and, asc, desc, eq, lt, lte, ne, sql } from "drizzle-orm";
import type { WebhookEventRepository } from "../../domain/repositories/WebhookEventRepository.js";
import type { Database } from "../client.js";
import { appDeveloper, appWebhookEvent } from "../schema/index.js";

export const createWebhookEventRepository = (db: Database): WebhookEventRepository => ({
  async enqueue(event) {
    await db.insert(appWebhookEvent).values(event);
  },

  async purgeFinishedBefore(before) {
    await db.delete(appWebhookEvent).where(and(ne(appWebhookEvent.status, "pending"), lt(appWebhookEvent.createdAt, before)));
  },

  claimDue(now, leaseUntil) {
    return db.transaction(async (tx) => {
      const [ev] = await tx
        .select({ event: appWebhookEvent, webhookUrl: appDeveloper.webhookUrl, webhookSecret: appDeveloper.webhookSecret })
        .from(appWebhookEvent)
        .innerJoin(appDeveloper, eq(appDeveloper.id, appWebhookEvent.developerId))
        .where(and(eq(appWebhookEvent.status, "pending"), lte(appWebhookEvent.nextAttemptAt, now)))
        .orderBy(asc(appWebhookEvent.nextAttemptAt))
        .limit(1)
        .for("update", { of: appWebhookEvent, skipLocked: true });
      if (!ev) return undefined;
      await tx.update(appWebhookEvent).set({ nextAttemptAt: leaseUntil }).where(eq(appWebhookEvent.id, ev.event.id));
      return { ...ev.event, webhookUrl: ev.webhookUrl, webhookSecret: ev.webhookSecret };
    });
  },

  async markDelivered(eventId) {
    await db
      .update(appWebhookEvent)
      .set({ status: "delivered", attempts: sql`${appWebhookEvent.attempts} + 1`, deliveredAt: sql`now()`, lastError: null })
      .where(eq(appWebhookEvent.id, eventId));
  },

  async markFailed(eventId, attempts, error) {
    await db.update(appWebhookEvent).set({ status: "failed", attempts, lastError: error }).where(eq(appWebhookEvent.id, eventId));
  },

  async abandon(eventId, error) {
    await db.update(appWebhookEvent).set({ status: "failed", lastError: error }).where(eq(appWebhookEvent.id, eventId));
  },

  async scheduleRetry(eventId, attempts, error, nextAttemptAt) {
    await db.update(appWebhookEvent).set({ attempts, lastError: error, nextAttemptAt }).where(eq(appWebhookEvent.id, eventId));
  },

  listForDeveloper(developerId, limit) {
    return db
      .select({
        id: appWebhookEvent.id,
        type: appWebhookEvent.type,
        status: appWebhookEvent.status,
        attempts: appWebhookEvent.attempts,
        lastError: appWebhookEvent.lastError,
        createdAt: appWebhookEvent.createdAt,
        deliveredAt: appWebhookEvent.deliveredAt,
      })
      .from(appWebhookEvent)
      .where(eq(appWebhookEvent.developerId, developerId))
      .orderBy(desc(appWebhookEvent.createdAt))
      .limit(limit);
  },
});
