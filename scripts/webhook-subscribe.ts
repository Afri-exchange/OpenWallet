// Points Miden's card and collection webhooks at <url> and registers MIDEN_WEBHOOK_HASH.
// This OVERWRITES the account's existing webhook config (PATCH /api/v1/webhook/subscribe).
// Run: node --env-file=.env --import tsx scripts/webhook-subscribe.ts https://host/path
import { MidenClient, MidenApiError, configFromEnv } from "../src/miden/client.js";

const url = process.argv[2];
const webhookHash = process.env.MIDEN_WEBHOOK_HASH;
if (!url?.startsWith("https://")) throw new Error("usage: webhook-subscribe.ts https://…");
if (!webhookHash || !/^[A-Za-z0-9]+$/.test(webhookHash)) throw new Error("MIDEN_WEBHOOK_HASH missing or not alphanumeric");

try {
  const res = await new MidenClient(configFromEnv()).request<Record<string, unknown>>("PATCH", "/api/v1/webhook/subscribe", {
    cardEventWebhookUrl: url,
    collectionEventWebhookUrl: url,
    webhookHash,
  });
  console.log(`ok: isSuccessful=${res.isSuccessful} responseCode=${res.responseCode} responseMessage=${res.responseMessage}`);
} catch (e) {
  console.error(e instanceof MidenApiError ? `failed: HTTP ${e.status} ${e.body.slice(0, 300)}` : `failed: ${(e as Error).message}`);
  process.exitCode = 1;
}
