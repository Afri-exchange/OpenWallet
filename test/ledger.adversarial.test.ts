import { test, after } from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import assert from "node:assert/strict";
import { Ledger, LedgerError, accounts, type Posting } from "../src/lib/services/Ledger.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createLedgerStore } from "../src/db/repositories/createLedgerStore.js";

// Set DATABASE_URL to also run every ledger test against a fresh Postgres schema.
const databaseUrl = process.env.DATABASE_URL;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const schemas: string[] = [];
const pools: pg.Pool[] = [];
async function fresh(now?: () => Date): Promise<Ledger> {
  if (!admin) return new Ledger(now);
  const schema = `adv_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  // tests in a file run one at a time, so the previous test's pool can be closed (Postgres caps connections)
  await Promise.all(pools.splice(0).map((p) => p.end()));
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  pools.push(pool);
  await migrate(pool);
  return new Ledger(now, createLedgerStore(createDatabase(pool)));
}
after(async () => {
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

// Tests prefixed "BUG:" assert behaviour we want that the ledger did not have when they were written.
// Everything else is a guard that should keep holding.

const dep = { chain: "eth", asset: "USDC", cardId: "c1", amountCents: 10_000, txHash: "0xabc", logIndex: 0 };

const rejects = (f: () => Promise<unknown>) => assert.rejects(async () => f(), LedgerError);
const bal = (l: Ledger, a: string) => l.balance(a);

async function fund(l: Ledger, fundingId: string, amountCents: number, feeCents?: number, cardId = "c1") {
  await l.reserveFunding({ cardId, amountCents, fundingId });
  return l.completeFunding({ cardId, amountCents, feeCents, fundingId });
}

const CARDS = ["c1", "c2", "c3"];
const ACCTS = [
  accounts.external("USDC"),
  accounts.external("USDT"),
  accounts.merchant(),
  accounts.fees(),
  ...CARDS.flatMap((c) => [accounts.holding(c), accounts.pending(c), accounts.card(c)]),
];

async function total(l: Ledger) {
  let s = 0;
  for (const a of ACCTS) s += await l.balance(a);
  return s;
}

// ---- duplicate / concurrent deposits ----

test("same deposit replayed sequentially credits once and returns the original", async () => {
  const l = await fresh();
  const first = await l.confirmDeposit(dep);
  for (let i = 0; i < 50; i++) assert.equal((await l.confirmDeposit(dep)).seq, first.seq);
  assert.equal(await bal(l, accounts.holding("c1")), 10_000);
  assert.equal((await l.history(accounts.holding("c1"))).length, 1);
});

test("50 concurrent identical deposits credit once", async () => {
  const l = await fresh();
  const res = await Promise.all(Array.from({ length: 50 }, () => l.confirmDeposit(dep)));
  assert.equal(new Set(res.map((r) => r.seq)).size, 1);
  assert.equal(await bal(l, accounts.holding("c1")), 10_000);
});

test("concurrent deposits with the same key but different amounts: exactly one wins, the rest are LedgerErrors", async () => {
  const l = await fresh();
  const res = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => l.confirmDeposit({ ...dep, amountCents: n * 100 })));
  const ok = res.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1);
  for (const r of res) if (r.status === "rejected") assert.ok(r.reason instanceof LedgerError, String(r.reason));
  assert.equal(await bal(l, accounts.holding("c1")), (ok[0] as PromiseFulfilledResult<{ postings: Posting[] }>).value.postings[1]!.amountCents);
});

test("same key, different amount / card / asset is rejected and changes nothing", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await rejects(() => l.confirmDeposit({ ...dep, amountCents: 20_000 }));
  await rejects(() => l.confirmDeposit({ ...dep, cardId: "c2" }));
  await rejects(() => l.confirmDeposit({ ...dep, asset: "USDT" }));
  assert.equal(await bal(l, accounts.holding("c1")), 10_000);
  assert.equal(await bal(l, accounts.holding("c2")), 0);
  assert.equal(await bal(l, accounts.external("USDT")), 0);
});

test("distinct logIndex / chain / hash are distinct deposits", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.confirmDeposit({ ...dep, logIndex: 1 });
  await l.confirmDeposit({ ...dep, chain: "base" });
  await l.confirmDeposit({ ...dep, txHash: "0xabd" });
  assert.equal(await bal(l, accounts.holding("c1")), 40_000);
});

test("hash case and surrounding whitespace do not create a second deposit", async () => {
  const l = await fresh();
  await l.confirmDeposit({ ...dep, txHash: "0xAbC" });
  for (const h of ["0xabc", "0XABC", " 0xabc ", "0xAbC\n"]) {
    try {
      await l.confirmDeposit({ ...dep, txHash: h });
    } catch (e) {
      assert.ok(e instanceof LedgerError);
    }
  }
  assert.equal(await bal(l, accounts.holding("c1")), 10_000);
});

test("BUG: chain case/whitespace variants are the same deposit", async () => {
  const l = await fresh();
  await l.confirmDeposit({ ...dep, chain: "ETH" });
  try {
    await l.confirmDeposit({ ...dep, chain: " eth " });
  } catch (e) {
    assert.ok(e instanceof LedgerError);
  }
  assert.equal(await bal(l, accounts.holding("c1")), 10_000);
});

test("BUG: replaying the same deposit with different hash casing returns the original instead of throwing", async () => {
  // A re-org watcher or second indexer may report the same log with different casing. That is a replay, not a conflict.
  const l = await fresh();
  const a = await l.confirmDeposit({ ...dep, txHash: "0xAbC" });
  const b = await l.confirmDeposit({ ...dep, txHash: "0xabc" });
  assert.equal(b.seq, a.seq);
});

test("BUG: unknown asset is rejected (otherwise any string mints USD 1:1 from external:<asset>)", async () => {
  const l = await fresh();
  await rejects(() => l.confirmDeposit({ ...dep, asset: "FAKECOIN" }));
  assert.equal(await bal(l, accounts.holding("c1")), 0);
});

test("BUG: asset aliases cannot hit internal external accounts (asset 'merchant')", async () => {
  const l = await fresh();
  await rejects(() => l.confirmDeposit({ ...dep, asset: "merchant" }));
});

// ---- bad input ----

const BAD: [string, number][] = [
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["fractional", 10.5],
  ["zero", 0],
  ["negative", -4_000],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
];

for (const [name, v] of BAD) {
  test(`every helper rejects ${name} amount and changes nothing`, async () => {
    const l = await fresh();
    await l.confirmDeposit(dep);
    await fund(l, "f0", 5_000);
    await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "fr" });
    const before = await total(l);
    await rejects(() => l.confirmDeposit({ ...dep, txHash: "0xnew", amountCents: v }));
    await rejects(() => l.reserveFunding({ cardId: "c1", amountCents: v, fundingId: "x1" }));
    await rejects(() => l.completeFunding({ cardId: "c1", amountCents: v, fundingId: "fr" }));
    await rejects(() => l.releaseFunding({ cardId: "c1", amountCents: v, fundingId: "fr" }));
    await rejects(() => l.recordSpend({ cardId: "c1", amountCents: v, spendId: "s1" }));
    assert.equal(await total(l), before);
    assert.equal(await bal(l, accounts.card("c1")), 5_000);
    assert.equal(await bal(l, accounts.holding("c1")), 4_000);
    assert.equal(await bal(l, accounts.pending("c1")), 1_000);
    assert.equal(await bal(l, accounts.merchant()), 0);
  });
}

test("BUG: validation failures are rejected promises, not synchronous throws", async () => {
  const l = await fresh();
  const calls: [string, () => Promise<unknown>][] = [
    ["confirmDeposit", () => l.confirmDeposit({ ...dep, amountCents: -1 })],
    ["reserveFunding", () => l.reserveFunding({ cardId: "c1", amountCents: -1, fundingId: "f" })],
    ["completeFunding", () => l.completeFunding({ cardId: "c1", amountCents: -1, fundingId: "f" })],
    ["releaseFunding", () => l.releaseFunding({ cardId: "c1", amountCents: -1, fundingId: "f" })],
    ["recordSpend", () => l.recordSpend({ cardId: "c1", amountCents: -1, spendId: "s" })],
  ];
  for (const [name, call] of calls) {
    let p: Promise<unknown> | undefined;
    try {
      p = call();
    } catch {
      assert.fail(`${name} threw synchronously; callers using .catch()/await-in-Promise.all lose the error channel`);
    }
    await assert.rejects(p!, LedgerError);
  }
});

test("empty / blank ids are rejected", async () => {
  const l = await fresh();
  await rejects(() => l.confirmDeposit({ ...dep, txHash: "" }));
  await rejects(() => l.confirmDeposit({ ...dep, txHash: "   " }));
  await rejects(() => l.confirmDeposit({ ...dep, chain: "" }));
  await rejects(() => l.confirmDeposit({ ...dep, cardId: "" }));
  await rejects(() => l.confirmDeposit({ ...dep, cardId: "has space" }));
  await rejects(() => l.reserveFunding({ cardId: "c1", amountCents: 1, fundingId: "" }));
  await rejects(() => l.recordSpend({ cardId: "c1", amountCents: 1, spendId: "" }));
});

test("negative / fractional / NaN logIndex rejected", async () => {
  const l = await fresh();
  for (const logIndex of [-1, 0.5, NaN, Infinity]) await rejects(() => l.confirmDeposit({ ...dep, logIndex }));
});

test("balances may not leave the safe-integer range", async () => {
  const l = await fresh();
  await l.confirmDeposit({ ...dep, txHash: "0x1", amountCents: Number.MAX_SAFE_INTEGER });
  await rejects(() => l.confirmDeposit({ ...dep, txHash: "0x2", amountCents: 1 }));
  assert.equal(await bal(l, accounts.holding("c1")), Number.MAX_SAFE_INTEGER);
});

// ---- fees ----

test("fee >= amount, negative, NaN, fractional are rejected and the reserve stays open", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  for (const fee of [1_000, 1_001, -1, NaN, 0.5, Infinity]) {
    await rejects(() => l.completeFunding({ cardId: "c1", amountCents: 1_000, feeCents: fee, fundingId: "f1" }));
  }
  assert.equal(await bal(l, accounts.pending("c1")), 1_000);
  assert.equal(await bal(l, accounts.fees()), 0);
  await l.completeFunding({ cardId: "c1", amountCents: 1_000, feeCents: 999, fundingId: "f1" });
  assert.equal(await bal(l, accounts.card("c1")), 1);
  assert.equal(await bal(l, accounts.fees()), 999);
});

// ---- reserve / complete / release ----

test("complete without a reserve is rejected (funding before deposit and before reserve)", async () => {
  const l = await fresh();
  await rejects(() => l.completeFunding({ cardId: "c1", amountCents: 100, fundingId: "f1" }));
  await l.confirmDeposit(dep);
  await rejects(() => l.completeFunding({ cardId: "c1", amountCents: 100, fundingId: "f1" }));
  assert.equal(await bal(l, accounts.card("c1")), 0);
  assert.equal(await bal(l, accounts.holding("c1")), 10_000);
});

test("reserve before deposit is rejected", async () => {
  const l = await fresh();
  await rejects(() => l.reserveFunding({ cardId: "c1", amountCents: 1, fundingId: "f1" }));
});

test("complete/release must match the reserve's card and amount", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.confirmDeposit({ ...dep, cardId: "c2", txHash: "0xother" });
  await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  await rejects(() => l.completeFunding({ cardId: "c1", amountCents: 999, fundingId: "f1" }));
  await rejects(() => l.completeFunding({ cardId: "c1", amountCents: 1_001, fundingId: "f1" }));
  await rejects(() => l.completeFunding({ cardId: "c2", amountCents: 1_000, fundingId: "f1" }));
  await rejects(() => l.releaseFunding({ cardId: "c2", amountCents: 1_000, fundingId: "f1" }));
  await rejects(() => l.releaseFunding({ cardId: "c1", amountCents: 500, fundingId: "f1" }));
  assert.equal(await bal(l, accounts.pending("c1")), 1_000);
  assert.equal(await bal(l, accounts.pending("c2")), 0);
});

test("two concurrent reserves that together exceed holding: exactly one succeeds", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  const res = await Promise.allSettled([
    l.reserveFunding({ cardId: "c1", amountCents: 6_000, fundingId: "a" }),
    l.reserveFunding({ cardId: "c1", amountCents: 6_000, fundingId: "b" }),
  ]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await bal(l, accounts.holding("c1")), 4_000);
  assert.equal(await bal(l, accounts.pending("c1")), 6_000);
});

test("20 concurrent reserves of 1,000 against 10,000: exactly 10 succeed", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: `f${i}` })));
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 10);
  assert.equal(await bal(l, accounts.holding("c1")), 0);
});

test("reserve replay is idempotent and does not reserve twice; changed amount is rejected", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  const a = await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  const b = await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  assert.equal(a.seq, b.seq);
  await rejects(() => l.reserveFunding({ cardId: "c1", amountCents: 2_000, fundingId: "f1" }));
  assert.equal(await bal(l, accounts.pending("c1")), 1_000);
});

test("complete and release are mutually exclusive, in either order", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  await l.releaseFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  await rejects(() => l.completeFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" }));
  await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f2" });
  await l.completeFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f2" });
  await rejects(() => l.releaseFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f2" }));
  assert.equal(await bal(l, accounts.holding("c1")), 9_000);
  assert.equal(await bal(l, accounts.card("c1")), 1_000);
  assert.equal(await bal(l, accounts.pending("c1")), 0);
});

test("racing complete vs release on one reserve: exactly one settles, pending ends at zero", async () => {
  for (let i = 0; i < 20; i++) {
    const l = await fresh();
    await l.confirmDeposit(dep);
    await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f" });
    const res = await Promise.allSettled([
      l.completeFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f" }),
      l.releaseFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f" }),
    ]);
    assert.equal(res.filter((r) => r.status === "fulfilled").length, 1, `iteration ${i}`);
    assert.equal(await bal(l, accounts.pending("c1")), 0);
    assert.equal((await bal(l, accounts.card("c1"))) + (await bal(l, accounts.holding("c1"))), 10_000);
  }
});

test("complete / release replay returns the original; changed fee on replay is rejected", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  const a = await l.completeFunding({ cardId: "c1", amountCents: 1_000, feeCents: 10, fundingId: "f1" });
  assert.equal((await l.completeFunding({ cardId: "c1", amountCents: 1_000, feeCents: 10, fundingId: "f1" })).seq, a.seq);
  await rejects(() => l.completeFunding({ cardId: "c1", amountCents: 1_000, feeCents: 20, fundingId: "f1" }));
  assert.equal(await bal(l, accounts.fees()), 10);
  assert.equal(await bal(l, accounts.card("c1")), 990);
});

test("funding ids are scoped per step: a spend id equal to a funding id does not alias", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await fund(l, "x", 1_000);
  await l.recordSpend({ cardId: "c1", amountCents: 100, spendId: "x" });
  assert.equal(await bal(l, accounts.card("c1")), 900);
});

test("funding id reused for another card is rejected", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.confirmDeposit({ ...dep, cardId: "c2", txHash: "0xo" });
  await l.reserveFunding({ cardId: "c1", amountCents: 100, fundingId: "f1" });
  await rejects(() => l.reserveFunding({ cardId: "c2", amountCents: 100, fundingId: "f1" }));
});

// ---- spend ----

test("spend after partial funding cannot exceed what was funded net of fee", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await fund(l, "f1", 5_000, 50);
  await rejects(() => l.recordSpend({ cardId: "c1", amountCents: 4_951, spendId: "s1" }));
  await l.recordSpend({ cardId: "c1", amountCents: 4_950, spendId: "s2" });
  assert.equal(await bal(l, accounts.card("c1")), 0);
  assert.equal(await bal(l, accounts.holding("c1")), 5_000);
});

test("reserved-but-unconfirmed funds cannot be spent", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.reserveFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" });
  await rejects(() => l.recordSpend({ cardId: "c1", amountCents: 1, spendId: "s1" }));
});

test("deposited-but-unfunded money cannot be spent; cards are isolated", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await rejects(() => l.recordSpend({ cardId: "c1", amountCents: 1, spendId: "s1" }));
  await fund(l, "f1", 10_000);
  await rejects(() => l.recordSpend({ cardId: "c2", amountCents: 1, spendId: "s2" }));
});

test("20 concurrent spends of 1,000 on a 5,000 card: exactly 5 succeed, balance ends at 0", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await fund(l, "f1", 5_000);
  const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => l.recordSpend({ cardId: "c1", amountCents: 1_000, spendId: `s${i}` })));
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(await bal(l, accounts.card("c1")), 0);
  assert.equal(await bal(l, accounts.merchant()), 5_000);
});

test("the same spend id concurrently charges once", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await fund(l, "f1", 5_000);
  await Promise.all(Array.from({ length: 10 }, () => l.recordSpend({ cardId: "c1", amountCents: 1_000, spendId: "same" })));
  assert.equal(await bal(l, accounts.card("c1")), 4_000);
});

// ---- reversal ----

test("reverse of a spend restores the card; second reverse is a replay; reversing the reversal is rejected", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await fund(l, "f1", 5_000);
  const spend = await l.recordSpend({ cardId: "c1", amountCents: 1_000, spendId: "s1" });
  const rev = await l.reverse({ seq: spend.seq });
  assert.equal(rev.kind, "reversal");
  assert.equal(await bal(l, accounts.card("c1")), 5_000);
  assert.equal((await l.reverse({ seq: spend.seq })).seq, rev.seq, "second reverse must not apply twice");
  assert.equal(await bal(l, accounts.card("c1")), 5_000);
  await rejects(() => l.reverse({ seq: rev.seq }));
});

test("concurrent reverses of one transaction apply once", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await fund(l, "f1", 5_000);
  const spend = await l.recordSpend({ cardId: "c1", amountCents: 1_000, spendId: "s1" });
  await Promise.allSettled(Array.from({ length: 10 }, () => l.reverse({ seq: spend.seq })));
  assert.equal(await bal(l, accounts.card("c1")), 5_000);
});

test("reverse of a deposit whose money has moved on is rejected (no overdraft via reversal)", async () => {
  const l = await fresh();
  const d = await l.confirmDeposit(dep);
  await fund(l, "f1", 10_000);
  await rejects(() => l.reverse({ seq: d.seq }));
  assert.equal(await bal(l, accounts.card("c1")), 10_000);
  assert.equal(await bal(l, accounts.holding("c1")), 0);
});

test("reverse of an unspent deposit zeroes holding and a replay does not re-credit", async () => {
  const l = await fresh();
  const d = await l.confirmDeposit(dep);
  await l.reverse({ seq: d.seq });
  assert.equal(await bal(l, accounts.holding("c1")), 0);
  // The original key is still taken, so a replay of the deposit must not silently re-credit.
  const replay = await l.confirmDeposit(dep);
  assert.equal(replay.seq, d.seq);
  assert.equal(await bal(l, accounts.holding("c1")), 0, "replaying a reversed deposit must not re-credit");
});

test("reverse of unknown / non-integer seq is rejected", async () => {
  const l = await fresh();
  for (const seq of [0, -1, 999, 1.5, NaN]) await rejects(() => l.reverse({ seq }));
});

test("BUG: reversing a funding release must not strand the pending funds", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  const rel = await l.releaseFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  try {
    await l.reverse({ seq: rel.seq });
  } catch {
    return; // refusing the reversal is acceptable
  }
  // reversal succeeded: 1,000 is back in pending, but both terminal keys are now taken, so it can never leave
  let settled = false;
  for (const f of [() => l.completeFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" }), () => l.releaseFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" })]) {
    try {
      await f();
      if ((await bal(l, accounts.pending("c1"))) === 0) settled = true;
    } catch {
      /* try next */
    }
  }
  assert.ok(settled || (await bal(l, accounts.pending("c1"))) === 0, "funds stuck in pending:c1 forever");
});

test("a reserve cannot be reversed, so the reservation stays intact and the card is not credited early", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  const r = await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f1" });
  await rejects(() => l.reverse({ seq: r.seq })); // funding transactions cannot be reversed
  assert.equal(await bal(l, accounts.card("c1")), 0);
  assert.equal(await bal(l, accounts.pending("c1")), 1_000);
});

// ---- raw post ----

test("multi-posting tx that nets an account negative is rejected atomically", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await rejects(() =>
    l.post({
      idempotencyKey: "m1",
      kind: "x",
      postings: [
        { account: accounts.holding("c1"), amountCents: -6_000 },
        { account: accounts.holding("c1"), amountCents: -6_000 },
        { account: accounts.card("c1"), amountCents: 12_000 },
      ],
    }),
  );
  assert.equal(await bal(l, accounts.holding("c1")), 10_000);
  assert.equal(await bal(l, accounts.card("c1")), 0);
});

test("overdraft hidden behind a credit to a third account is caught; no partial application", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await rejects(() =>
    l.post({
      idempotencyKey: "m2",
      kind: "x",
      postings: [
        { account: accounts.external("USDC"), amountCents: -500 },
        { account: accounts.card("c3"), amountCents: 500 },
        { account: accounts.holding("c1"), amountCents: -10_001 },
        { account: accounts.card("c2"), amountCents: 10_001 },
      ],
    }),
  );
  assert.equal(await bal(l, accounts.card("c3")), 0);
  assert.equal(await bal(l, accounts.external("USDC")), -10_000);
});

test("zero-net same-account postings, unbalanced, single, empty, bad account ids are rejected", async () => {
  const l = await fresh();
  const p = (k: string, postings: Posting[]) => () => l.post({ idempotencyKey: k, kind: "x", postings });
  await rejects(p("a", []));
  await rejects(p("b", [{ account: "external:a", amountCents: 1 }]));
  await rejects(p("c", [{ account: "external:a", amountCents: 1 }, { account: "card:c", amountCents: -2 }]));
  await rejects(p("d", [{ account: "nocolon", amountCents: -1 }, { account: "card:c", amountCents: 1 }]));
  await rejects(p("e", [{ account: "Card:c", amountCents: -1 }, { account: "card:c", amountCents: 1 }]));
  await rejects(p("f", [{ account: "external:a", amountCents: -1 }, { account: "card:c", amountCents: 0 }, { account: "card:d", amountCents: 1 }]));
  await rejects(p("g", [{ account: "external:a", amountCents: -Number.MAX_SAFE_INTEGER }, { account: "external:b", amountCents: -Number.MAX_SAFE_INTEGER }, { account: "card:c", amountCents: Number.MAX_SAFE_INTEGER }, { account: "card:d", amountCents: Number.MAX_SAFE_INTEGER }]));
});

test("rejected key is not remembered: a corrected retry with the same key succeeds", async () => {
  const l = await fresh();
  await rejects(() => l.recordSpend({ cardId: "c1", amountCents: 100, spendId: "s1" }));
  await l.confirmDeposit(dep);
  await fund(l, "f1", 1_000);
  await l.recordSpend({ cardId: "c1", amountCents: 100, spendId: "s1" });
  assert.equal(await bal(l, accounts.card("c1")), 900);
});

test("BUG: raw post() cannot mint from an invented external:* account (or post is not public)", async () => {
  const l = await fresh();
  await rejects(() =>
    l.post({
      idempotencyKey: "mint",
      kind: "adjustment",
      postings: [
        { account: "external:made-up", amountCents: -1_000_000 },
        { account: accounts.card("c1"), amountCents: 1_000_000 },
      ],
    }),
  );
  assert.equal(await bal(l, accounts.card("c1")), 0);
});

test("BUG: raw post() cannot bypass reserve/complete state with a forged funding kind", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  // skips reserve and moves holding straight to card, under a key that complete/release guards never see
  await rejects(() =>
    l.post({
      idempotencyKey: "sneaky",
      kind: "funding",
      postings: [
        { account: accounts.holding("c1"), amountCents: -1_000 },
        { account: accounts.card("c1"), amountCents: 1_000 },
      ],
    }),
  );
});

// ---- append-only integrity ----

test("results and history are immutable; mutation attempts do not change stored history", async () => {
  const l = await fresh();
  const tx = await l.confirmDeposit(dep);
  assert.ok(Object.isFrozen(tx) && Object.isFrozen(tx.postings) && Object.isFrozen(tx.postings[0]));
  assert.throws(() => {
    (tx.postings[1] as Posting).amountCents = 1;
  }, TypeError);
  const h = await l.history(accounts.holding("c1"));
  assert.throws(() => {
    (h[0]!.postings as Posting[]).push({ account: "card:z", amountCents: 1 });
  }, TypeError);
  assert.equal((await l.confirmDeposit(dep)).postings[1]!.amountCents, 10_000);
});

test("caller-supplied seq / createdAt / reversesSeq on post() are ignored", async () => {
  const l = await fresh(() => new Date("2026-10-13T00:00:00Z"));
  const tx = await l.post({ idempotencyKey: "k", kind: "x", seq: 999, createdAt: "1999", reversesSeq: 1, postings: [{ account: "external:USDC", amountCents: -1 }, { account: "fees:fees", amountCents: 1 }] } as never);
  assert.equal(tx.seq, 1);
  assert.equal(tx.createdAt, "2026-10-13T00:00:00.000Z");
  assert.equal(tx.reversesSeq, undefined);
});

test("seq is gap-free and rejected transactions do not consume one", async () => {
  const l = await fresh();
  await l.confirmDeposit(dep);
  await rejects(() => l.recordSpend({ cardId: "c1", amountCents: 1, spendId: "s" }));
  assert.equal((await l.confirmDeposit({ ...dep, txHash: "0x2" })).seq, 2);
});

test("seqs are unique and gap-free under heavy concurrency", async () => {
  const l = await fresh();
  const res = await Promise.all(Array.from({ length: 100 }, (_, i) => l.confirmDeposit({ ...dep, txHash: `0x${i}` })));
  assert.deepEqual([...res.map((r) => r.seq)].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 1));
});

// ---- randomised invariants (seeded, mixed sequential and concurrent) ----

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("randomised ops: balances sum to zero and no internal account goes negative, ever", async () => {
  for (const seed of [1, 2, 3, 42, 1337]) {
    const r = rng(seed);
    const l = await fresh();
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const seqs: number[] = [];
    let applied = 0;
    const op = async () => {
      const card = pick(CARDS);
      const amt = Math.floor(r() * 5_000) + (r() < 0.05 ? 0 : 1);
      const id = String(Math.floor(r() * 300)); // forces id reuse
      switch (Math.floor(r() * 6)) {
        case 0:
          return l.confirmDeposit({ chain: pick(["eth", "base"]), asset: pick(["USDC", "USDT"]), cardId: card, amountCents: amt, txHash: `0xH${id}`, logIndex: Math.floor(r() * 2) });
        case 1:
          return l.reserveFunding({ cardId: card, amountCents: amt, fundingId: id });
        case 2:
          return l.completeFunding({ cardId: card, amountCents: amt, feeCents: r() < 0.5 ? 0 : Math.floor(r() * 50), fundingId: id });
        case 3:
          return l.releaseFunding({ cardId: card, amountCents: amt, fundingId: id });
        case 4:
          return l.recordSpend({ cardId: card, amountCents: amt, spendId: id });
        default:
          return l.reverse({ seq: Math.floor(r() * (seqs.length + 2)) });
      }
    };
    for (let i = 0; i < 1_500; i++) {
      const batch = r() < 0.3 ? 1 : 8;
      const out = await Promise.allSettled(Array.from({ length: batch }, () => op()));
      for (const o of out) {
        if (o.status === "fulfilled") {
          applied++;
          seqs.push(o.value.seq);
        } else assert.ok(o.reason instanceof LedgerError, `non-ledger error: ${String(o.reason)}`);
      }
      assert.equal(await total(l), 0, `sum != 0 at step ${i}, seed ${seed}`);
      if (i % 50 === 0) {
        for (const c of CARDS) for (const a of [accounts.holding(c), accounts.pending(c), accounts.card(c)]) assert.ok((await l.balance(a)) >= 0, `${a} negative, seed ${seed}`);
      }
    }
    for (const c of CARDS) for (const a of [accounts.holding(c), accounts.pending(c), accounts.card(c)]) assert.ok((await l.balance(a)) >= 0, `${a} negative, seed ${seed}`);
    assert.ok(applied > 200, `fuzz applied only ${applied} ops`);
  }
});

test("balances equal the sum of each account's history (derived state agrees with the log)", async () => {
  const r = rng(7);
  const l = await fresh();
  for (let i = 0; i < 300; i++) {
    try {
      await l.confirmDeposit({ ...dep, txHash: `0x${i}`, amountCents: Math.floor(r() * 900) + 1 });
      if (r() < 0.6) await fund(l, `f${i}`, Math.floor(r() * 300) + 1, 1 + Math.floor(r() * 0));
      if (r() < 0.3) await l.recordSpend({ cardId: "c1", amountCents: Math.floor(r() * 100) + 1, spendId: `s${i}` });
      if (r() < 0.1) await l.reverse({ seq: Math.floor(r() * (i + 1)) + 1 });
    } catch (e) {
      assert.ok(e instanceof LedgerError, String(e));
    }
  }
  for (const a of ACCTS) {
    const fromLog = (await l.history(a)).flatMap((t) => t.postings).filter((p) => p.account === a).reduce((s, p) => s + p.amountCents, 0);
    assert.equal(await l.balance(a), fromLog, a);
  }
});
