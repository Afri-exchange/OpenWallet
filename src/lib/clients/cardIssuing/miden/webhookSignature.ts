import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Miden webhook signature, per docs.miden.co "Generate Webhook Signature Hash":
 * lowercase hex HMAC-SHA256, keyed with the webhook hash, over `${eventId}&${eventTime}`,
 * sent in the `x-signature` header. eventId and eventTime must be the exact strings from the payload.
 *
 * The docs' published sample output does not match their own algorithm, so this is
 * confirmed only by live sandbox deliveries (see docs/miden-api.md).
 *
 * The signature covers eventId and eventTime only, not the body: a verified webhook
 * proves Miden sent *an* event with that id, not that the amounts in it are untampered.
 * Re-read state from the API before acting on money fields.
 */
export function webhookSignature(eventId: string, eventTime: string, webhookHash: string): string {
  return createHmac("sha256", webhookHash).update(`${eventId}&${eventTime}`, "utf8").digest("hex");
}

/** Constant-time check of the `x-signature` header against the raw JSON body. */
export function verifyWebhook(rawBody: string, signatureHeader: string | undefined, webhookHash: string): boolean {
  if (!signatureHeader || !webhookHash) return false;
  let event: { eventId?: unknown; eventTime?: unknown };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }
  if (event.eventId === undefined || event.eventId === null || typeof event.eventTime !== "string") return false;
  const want = Buffer.from(webhookSignature(String(event.eventId), event.eventTime, webhookHash));
  const got = Buffer.from(signatureHeader.trim().toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}
