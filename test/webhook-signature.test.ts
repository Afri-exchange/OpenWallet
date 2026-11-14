import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyWebhook, webhookSignature } from "../src/lib/clients/cardIssuing/miden/webhookSignature.js";

// Independent: printf '%s' '26184906&2025-07-24 13:32:55' | openssl dgst -sha256 -hmac mySecret
// (The docs' own sample output, 97b24d88…, does not match their algorithm; see docs/miden-api.md.)
const SIG = "4ece709503b6f4bff4ebb9f6f20b8de98e6fbd54bb32bb4774b3aad3871cdd54";
const body = JSON.stringify({ cardId: "c1", eventId: "26184906", eventTime: "2025-07-24 13:32:55", eventType: "purchase.card.withdrawal" });

test("matches an openssl HMAC-SHA256 vector", () => assert.equal(webhookSignature("26184906", "2025-07-24 13:32:55", "mySecret"), SIG));
test("verifies a correctly signed body, case-insensitive header", () => {
  assert.equal(verifyWebhook(body, SIG, "mySecret"), true);
  assert.equal(verifyWebhook(body, SIG.toUpperCase(), "mySecret"), true);
});
test("rejects wrong key, wrong signature, missing header, bad JSON, missing fields", () => {
  assert.equal(verifyWebhook(body, SIG, "otherSecret"), false);
  assert.equal(verifyWebhook(body, SIG.replace(/.$/, "0"), "mySecret"), false);
  assert.equal(verifyWebhook(body, undefined, "mySecret"), false);
  assert.equal(verifyWebhook(body, SIG, ""), false);
  assert.equal(verifyWebhook("{not json", SIG, "mySecret"), false);
  assert.equal(verifyWebhook(JSON.stringify({ eventId: "26184906" }), SIG, "mySecret"), false);
});
test("numeric eventId is signed as its decimal string", () => {
  assert.equal(verifyWebhook(JSON.stringify({ eventId: 26184906, eventTime: "2025-07-24 13:32:55" }), SIG, "mySecret"), true);
});
