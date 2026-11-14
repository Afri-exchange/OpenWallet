import { test } from "node:test";
import assert from "node:assert/strict";
import { CardLifecycle, poll } from "../src/adapters/virtualCards/CardLifecycle.js";
import type { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";

function fake(reply: unknown) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const miden = { request: async (method: string, path: string, body?: unknown) => (calls.push({ method, path, body }), reply) } as unknown as MidenClient;
  return { life: new CardLifecycle(miden), calls };
}

test("cardBalance reads availableBalance and rejects a business failure", async () => {
  assert.equal(await fake({ isSuccessful: true, responseCode: "000", availableBalance: 4.5 }).life.cardBalance("c1"), 4.5);
  await assert.rejects(fake({ isSuccessful: false, responseCode: "112", responseMessage: "Invalid card id" }).life.cardBalance("c1"), /112/);
});

test("kycStatus accepts the KYC '00' success code and encodes the reference", async () => {
  const { life, calls } = fake({ isSuccessful: true, responseCode: "00", kycStatus: "Approved", customerId: "cu1", kycToken: "t" });
  assert.deepEqual(await life.kycStatus("a b"), { status: "Approved", customerId: "cu1", kycToken: "t" });
  assert.equal(calls[0]!.path, "/api/v1/cards/kyc/client-reference/a%20b");
});

test("simulateAuthorization posts the mock body with the card, amount and MCC", async () => {
  const { life, calls } = fake({ isSuccessful: true, responseCode: "000", authorizationId: "au1" });
  assert.equal(await life.simulateAuthorization({ cardId: "c1", amountDollars: 2, mcc: "5411" }), "au1");
  const body = calls[0]!.body as { cardId: string; amount: number; status: string; cardAcceptor: { mcc: string } };
  assert.deepEqual([calls[0]!.path, body.cardId, body.amount, body.status, body.cardAcceptor.mcc], ["/api/v1/mock/authorization", "c1", 2, "Approved", "5411"]);
});

test("poll retries until done and times out otherwise", async () => {
  let n = 0;
  assert.equal(await poll(async () => ++n, (v) => v === 3, { intervalMs: 1, sleep: async () => {} }), 3);
  await assert.rejects(poll(async () => 0, () => false, { intervalMs: 50, timeoutMs: 60, sleep: async () => {} }), /timed out/);
});
