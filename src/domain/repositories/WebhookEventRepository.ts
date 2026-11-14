import type { WebhookEvent } from "../types/Entities.js";

/** A due event claimed for delivery, with its developer's current webhook settings. */
export type ClaimedWebhookEvent = WebhookEvent & { webhookUrl: string | null; webhookSecret: string | null };

/** app_webhook_event: the developer webhook outbox. pending -> delivered | failed. */
export interface WebhookEventRepository {
  enqueue(event: { id: string; developerId: string; type: string; body: string; nextAttemptAt: Date }): Promise<void>;
  /** Deletes finished (non-pending) events created before `before`. */
  purgeFinishedBefore(before: Date): Promise<void>;
  /**
   * Claims the earliest pending event due at `now` and pushes its next_attempt_at to `leaseUntil`, in one transaction.
   * SKIP LOCKED lets several processes share the queue; the lease means a crash mid-delivery is a later retry.
   */
  claimDue(now: Date, leaseUntil: Date): Promise<ClaimedWebhookEvent | undefined>;
  /** 2xx: delivered, one more attempt counted, delivered_at = the database's now(). */
  markDelivered(eventId: string): Promise<void>;
  /** Out of tries: failed, with the attempt count and the last error. */
  markFailed(eventId: string, attempts: number, error: string): Promise<void>;
  /** Failed without an attempt (e.g. the webhook was removed); attempts unchanged. */
  abandon(eventId: string, error: string): Promise<void>;
  scheduleRetry(eventId: string, attempts: number, error: string, nextAttemptAt: Date): Promise<void>;
  /** The developer's events, newest first (no bodies). */
  listForDeveloper(
    developerId: string,
    limit: number,
  ): Promise<Pick<WebhookEvent, "id" | "type" | "status" | "attempts" | "lastError" | "createdAt" | "deliveredAt">[]>;
}
