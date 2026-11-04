import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/lib/services/Ledger.js";
import { AgentWallets } from "../src/lib/services/AgentWallets.js";

async function setup(clock = { d: new Date("2026-10-19T10:00:00Z") }) {
  const ledger = new Ledger(() => clock.d);
  // $100 deposited, funded onto the card.
  await ledger.confirmDeposit({ chain: "base", asset: "USDC", cardId: "c1", amountCents: 10_000, txHash: "0xa", logIndex: 0 });
  await ledger.reserveFunding({ cardId: "c1", amountCents: 10_000, fundingId: "f1" });
  await ledger.completeFunding({ cardId: "c1", amountCents: 10_000, fundingId: "f1" });
  const wallets = new AgentWallets(ledger, () => clock.d);
  wallets.create("c1", "a1", { perTransactionCents: 2_000, dailyCents: 3_000 });
  wallets.create("c1", "a2", { perTransactionCents: 2_000, dailyCents: 3_000 });
  return { ledger, wallets, clock };
}

test("fund moves money from the card into the agent sub-balance", async () => {
  const { ledger, wallets } = await setup();
  await wallets.fund("c1", "a1", 4_000, "al1");
  assert.equal(await wallets.balance("c1", "a1"), 4_000);
  assert.equal(await ledger.balance("card:c1"), 6_000);
});

test("cannot allocate more than the card holds", async () => {
  const { wallets } = await setup();
  await assert.rejects(wallets.fund("c1", "a1", 10_001, "al1"), /insufficient/);
});

test("a retried allocation does not double-fund", async () => {
  const { wallets } = await setup();
  await wallets.fund("c1", "a1", 1_000, "al1");
  await wallets.fund("c1", "a1", 1_000, "al1");
  assert.equal(await wallets.balance("c1", "a1"), 1_000);
});

test("spend is limited by policy and by the sub-balance", async () => {
  const { wallets } = await setup();
  await wallets.fund("c1", "a1", 2_500, "al1");
  assert.deepEqual((await wallets.spend("c1", "a1", 2_001, "s1")).ok, false); // per-transaction
  assert.equal((await wallets.spend("c1", "a1", 2_000, "s2")).ok, true);
  const r = await wallets.spend("c1", "a1", 1_000, "s3"); // only 500 left
  assert.deepEqual(r, { ok: false, reason: "insufficient agent balance" });
  assert.equal(await wallets.balance("c1", "a1"), 500);
});

test("a failed spend does not use up the daily limit", async () => {
  const { wallets } = await setup();
  await wallets.fund("c1", "a1", 500, "al1");
  assert.equal((await wallets.spend("c1", "a1", 1_000, "s1")).ok, false);
  await wallets.fund("c1", "a1", 2_500, "al2");
  assert.equal((await wallets.spend("c1", "a1", 2_000, "s2")).ok, true);
  assert.equal((await wallets.spend("c1", "a1", 1_000, "s3")).ok, true); // 3,000 daily exactly
  assert.equal((await wallets.spend("c1", "a1", 1, "s4")).ok, false);
});

test("daily limit resets on a new UTC day", async () => {
  const { wallets, clock } = await setup();
  await wallets.fund("c1", "a1", 6_000, "al1");
  await wallets.spend("c1", "a1", 2_000, "s1");
  await wallets.spend("c1", "a1", 1_000, "s2");
  assert.equal((await wallets.spend("c1", "a1", 1_000, "s3")).ok, false);
  clock.d = new Date("2026-10-20T00:01:00Z");
  assert.equal((await wallets.spend("c1", "a1", 1_000, "s4")).ok, true);
});

test("retrying a spendId neither double-debits nor double-counts", async () => {
  const { wallets } = await setup();
  await wallets.fund("c1", "a1", 3_000, "al1");
  await wallets.spend("c1", "a1", 2_000, "s1");
  await wallets.spend("c1", "a1", 2_000, "s1");
  assert.equal(await wallets.balance("c1", "a1"), 1_000);
  assert.equal((await wallets.spend("c1", "a1", 1_000, "s2")).ok, true); // daily 3,000 not blown by the replay
});

test("agents are isolated from each other", async () => {
  const { wallets } = await setup();
  await wallets.fund("c1", "a1", 1_000, "al1");
  assert.deepEqual(await wallets.spend("c1", "a2", 500, "s1"), { ok: false, reason: "insufficient agent balance" });
  assert.equal(await wallets.balance("c1", "a1"), 1_000);
});

test("concurrent spends cannot overspend the sub-balance or the daily limit", async () => {
  const { wallets } = await setup();
  await wallets.fund("c1", "a1", 4_000, "al1");
  const rs = await Promise.all(["s1", "s2", "s3"].map((id) => wallets.spend("c1", "a1", 2_000, id)));
  assert.equal(rs.filter((r) => r.ok).length, 1); // daily 3,000 allows only one 2,000
});

test("reclaim returns unspent money to the card; cannot reclaim more than held", async () => {
  const { ledger, wallets } = await setup();
  await wallets.fund("c1", "a1", 1_000, "al1");
  await wallets.reclaim("c1", "a1", 400, "r1");
  assert.equal(await ledger.balance("card:c1"), 9_400);
  await assert.rejects(wallets.reclaim("c1", "a1", 601, "r2"), /insufficient/);
});

test("unknown agents and bad ids are refused", async () => {
  const { wallets, ledger } = await setup();
  await assert.rejects(wallets.fund("c1", "ghost", 100, "x"), /unknown agent/);
  assert.throws(() => wallets.create("c1", "a:b", { perTransactionCents: 1, dailyCents: 1 }), /agentId/);
  await assert.rejects(ledger.allocateToAgent({ cardId: "c1", agentId: "a b", amountCents: 1, allocationId: "z" }), /agentId/);
});

test("raw post cannot touch agent accounts or write agent kinds", async () => {
  const { ledger } = await setup();
  await assert.rejects(ledger.post({ idempotencyKey: "k", kind: "agent_allocate", postings: [{ account: "external:USDC", amountCents: -1 }, { account: "fees:fees", amountCents: 1 }] }), /reserved/);
  await assert.rejects(ledger.post({ idempotencyKey: "k2", kind: "adj", postings: [{ account: "external:USDC", amountCents: -1 }, { account: "agent:c1:a1", amountCents: 1 }] }), /cannot touch/);
});
