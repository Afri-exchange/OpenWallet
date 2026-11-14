import { test } from "node:test";
import assert from "node:assert/strict";
import { CardService } from "../src/adapters/virtualCards/CardService.js";
import { TieredCardIssuer, capPolicy, type TierLimits } from "../src/lib/services/tiers.js";
import type { FundingSource } from "../src/domain/interfaces/FundingSource.js";
import type { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";

const tiers = {
  quick: { perTransactionCents: 1_000, dailyCents: 2_000, lifetimeFundedCents: 5_000 },
  full: { perTransactionCents: 50_000, dailyCents: 100_000, lifetimeFundedCents: 10_000_000 },
} satisfies Record<string, TierLimits>;

const kyc = { customerId: "user1", kycToken: "ut" };

function fixture(failFunding = false) {
  const bodies: Array<Record<string, unknown>> = [];
  const miden = {
    request: async (_m: string, _p: string, body: Record<string, unknown>) => {
      bodies.push(body);
      return { isSuccessful: true, responseCode: "000", data: { cardId: "c1" } };
    },
  } as unknown as MidenClient;
  const funding: FundingSource = {
    fund: async () => {
      if (failFunding) throw new Error("boom");
      return { id: "r", status: "pending" };
    },
  };
  return { bodies, issuer: new TieredCardIssuer(new CardService(miden, funding), tiers) };
}

test("capPolicy lowers but never raises", () => {
  const p = capPolicy(tiers.quick, { perTransactionCents: 300, dailyCents: 99_999, allowedMccs: ["5411"] });
  assert.deepEqual(p, { perTransactionCents: 300, dailyCents: 2_000, allowedMccs: ["5411"] });
});

test("a card is issued under the user's own customer with the tier's limits", async () => {
  const { issuer, bodies } = fixture();
  const quick = await issuer.issue("u1", kyc, "quick", "ref1");
  assert.equal(quick.tier, "quick");
  assert.equal(bodies[0]!.customerId, "user1");
  assert.deepEqual(bodies[0]!.cardLimits, { dailyLimit: "20.00", transactionLimit: "10.00" });
  await issuer.issue("u1", kyc, "full", "ref2");
  assert.deepEqual(bodies[1]!.cardLimits, { dailyLimit: "1000.00", transactionLimit: "500.00" });
});

test("quick funding stops at the lifetime cap and asks for an upgrade", async () => {
  const { issuer } = fixture();
  const card = await issuer.issue("u1", kyc, "quick", "ref1");
  await issuer.topUp(card, 4_000, "USDC", "k1");
  await assert.rejects(issuer.topUp(card, 1_001, "USDC", "k2"), /verify identity/);
  await issuer.topUp(card, 1_000, "USDC", "k3");
  const d = issuer.checkFunding("u1", "quick", 1);
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.upgradeRequired, true);
});

test("a failed top-up does not use up the allowance", async () => {
  const { issuer } = fixture(true);
  const card = await issuer.issue("u1", kyc, "quick", "ref1");
  await assert.rejects(issuer.topUp(card, 5_000, "USDC", "k1"), /boom/);
  assert.equal(issuer.checkFunding("u1", "quick", 5_000).ok, true);
});

test("concurrent top-ups cannot both pass the cap", async () => {
  const { issuer } = fixture();
  const card = await issuer.issue("u1", kyc, "quick", "ref1");
  const results = await Promise.allSettled([issuer.topUp(card, 3_000, "USDC", "k1"), issuer.topUp(card, 3_000, "USDC", "k2")]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
});

test("limits are per user", async () => {
  const { issuer } = fixture();
  const a = await issuer.issue("u1", kyc, "quick", "r1");
  const b = await issuer.issue("u2", { customerId: "user2", kycToken: "t2" }, "quick", "r2");
  await issuer.topUp(a, 5_000, "USDC", "k1");
  await issuer.topUp(b, 5_000, "USDC", "k2");
});
