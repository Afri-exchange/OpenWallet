import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { Ledger, LedgerError, accounts } from "../src/lib/services/Ledger.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createLedgerStore } from "../src/db/repositories/createLedgerStore.js";
import type { LedgerRepository } from "../src/domain/repositories/LedgerStore.js";

const dep = { chain: "evm-1", asset: "USDC", cardId: "c1", amountCents: 10_000, txHash: "0xabc", logIndex: 0 };

/** Each case builds a fresh ledger. The Postgres variant gets its own schema so cases never share rows. */
interface Backend { name: string; make: () => Promise<{ ledger: Ledger; store?: LedgerRepository; pool?: pg.Pool }> }

const backends: Backend[] = [{ name: "memory", make: async () => ({ ledger: new Ledger() }) }];

const databaseUrl = process.env.DATABASE_URL;
const schemas: string[] = [];
let admin: pg.Pool | undefined;
if (databaseUrl) {
  admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  backends.push({
    name: "postgres",
    make: async () => {
      const schema = `t_${randomBytes(6).toString("hex")}`;
      await admin!.query(`CREATE SCHEMA ${schema}`);
      schemas.push(schema);
      const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
      await migrate(pool);
      const store = createLedgerStore(createDatabase(pool));
      return { ledger: new Ledger(undefined, store), store, pool };
    },
  });
}

after(async () => {
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

for (const backend of backends) {
  const t = (name: string, fn: (l: Ledger, store?: LedgerRepository) => Promise<void>) =>
    test(`[${backend.name}] ${name}`, async () => {
      const { ledger, store, pool } = await backend.make();
      try {
        await fn(ledger, store);
        const bad = await store?.checkIntegrity();
        if (bad) assert.deepEqual(bad, [], "stored balances must equal the sum of postings");
      } finally {
        await pool?.end();
      }
    });

  const fund = async (l: Ledger, amountCents = 10_000, fundingId = "f1") => {
    await l.reserveFunding({ cardId: "c1", amountCents, fundingId });
    return l.completeFunding({ cardId: "c1", amountCents, fundingId });
  };

  t("deposit credits holding 1:1 and replays idempotently", async (l) => {
    const a = await l.confirmDeposit(dep);
    const b = await l.confirmDeposit(dep);
    assert.deepEqual(a, b);
    assert.equal(await l.balance(accounts.holding("c1")), 10_000);
    assert.equal(await l.balance(accounts.external("USDC")), -10_000);
  });

  t("deposit key ignores txHash case but not chain or log index", async (l) => {
    await l.confirmDeposit({ ...dep, txHash: "0xABC" });
    await l.confirmDeposit({ ...dep, txHash: "0xabc" });
    assert.equal(await l.balance(accounts.holding("c1")), 10_000);
    await l.confirmDeposit({ ...dep, logIndex: 1 });
    await l.confirmDeposit({ ...dep, chain: "other" });
    assert.equal(await l.balance(accounts.holding("c1")), 30_000);
  });

  t("funding reserves, then completes to the card with the fee to fees", async (l) => {
    await l.confirmDeposit(dep);
    await l.reserveFunding({ cardId: "c1", amountCents: 10_000, fundingId: "f1" });
    assert.equal(await l.balance(accounts.holding("c1")), 0);
    assert.equal(await l.balance(accounts.pending("c1")), 10_000);
    await l.completeFunding({ cardId: "c1", amountCents: 10_000, feeCents: 100, fundingId: "f1" });
    assert.equal(await l.balance(accounts.pending("c1")), 0);
    assert.equal(await l.balance(accounts.card("c1")), 9_900);
    assert.equal(await l.balance(accounts.fees()), 100);
  });

  t("cannot reserve more than was deposited", async (l) => {
    await l.confirmDeposit(dep);
    await assert.rejects(l.reserveFunding({ cardId: "c1", amountCents: 10_001, fundingId: "f1" }), LedgerError);
    assert.equal(await l.balance(accounts.holding("c1")), 10_000);
  });

  t("concurrent reserves cannot both pass", async (l) => {
    await l.confirmDeposit(dep);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => l.reserveFunding({ cardId: "c1", amountCents: 6_000, fundingId: `f${i}` })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /insufficient funds/);
    assert.equal(await l.balance(accounts.holding("c1")), 4_000);
    assert.equal(await l.balance(accounts.pending("c1")), 6_000);
  });

  t("concurrent identical posts apply once", async (l) => {
    const out = await Promise.all(Array.from({ length: 8 }, () => l.confirmDeposit(dep)));
    assert.equal(new Set(out.map((o) => o.seq)).size, 1);
    assert.equal(await l.balance(accounts.holding("c1")), 10_000);
  });

  t("complete and release need a matching reserve and exclude each other", async (l) => {
    await l.confirmDeposit(dep);
    await assert.rejects(l.completeFunding({ cardId: "c1", amountCents: 5_000, fundingId: "nope" }), /no matching reservation/);
    await l.reserveFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" });
    await assert.rejects(l.completeFunding({ cardId: "c1", amountCents: 4_000, fundingId: "f1" }), /no matching reservation/);
    await l.releaseFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" });
    assert.equal(await l.balance(accounts.holding("c1")), 10_000);
    await assert.rejects(l.completeFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" }), /already settled/);
    await l.reserveFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f2" });
    await l.completeFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f2" });
    await assert.rejects(l.releaseFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f2" }), /already settled/);
  });

  t("a reservation cannot be completed against another funding's reserve", async (l) => {
    await l.confirmDeposit(dep);
    await l.reserveFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" });
    await l.reserveFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f2" });
    await l.completeFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" });
    await assert.rejects(l.completeFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1x" }), /no matching reservation/);
    assert.equal(await l.balance(accounts.pending("c1")), 5_000);
  });

  t("cannot spend more than the card balance", async (l) => {
    await l.confirmDeposit(dep);
    await fund(l);
    await l.recordSpend({ cardId: "c1", amountCents: 6_000, spendId: "s1" });
    await assert.rejects(l.recordSpend({ cardId: "c1", amountCents: 4_001, spendId: "s2" }), /insufficient funds/);
    assert.equal(await l.balance(accounts.card("c1")), 4_000);
  });

  t("helpers reject non-positive, fractional and out-of-range amounts", async (l) => {
    await l.confirmDeposit(dep);
    await fund(l);
    await assert.rejects(l.recordSpend({ cardId: "c1", amountCents: -500, spendId: "s1" }), LedgerError);
    await assert.rejects(l.recordSpend({ cardId: "c1", amountCents: 0, spendId: "s2" }), LedgerError);
    await assert.rejects(l.confirmDeposit({ ...dep, txHash: "0x2", amountCents: -1 }), LedgerError);
    await assert.rejects(l.reserveFunding({ cardId: "c1", amountCents: 1.5, fundingId: "x" }), LedgerError);
    await l.confirmDeposit({ ...dep, txHash: "0x3" });
    await assert.rejects(l.reserveFunding({ cardId: "c1", amountCents: 100, fundingId: "y" }).then(() => l.completeFunding({ cardId: "c1", amountCents: 100, feeCents: 100, fundingId: "y" })), LedgerError);
    await assert.rejects(l.completeFunding({ cardId: "c1", amountCents: 100, feeCents: -5, fundingId: "y" }), LedgerError);
    assert.equal(await l.balance(accounts.card("c1")), 10_000);
    assert.equal(await l.balance(accounts.merchant()), 0);
  });

  t("rejects unbalanced, empty, non-integer and malformed postings", async (l) => {
    const base = { idempotencyKey: "k", kind: "x" };
    const post = (postings: { account: string; amountCents: number }[], over = {}) => l.post({ ...base, ...over, postings });
    await assert.rejects(post([{ account: "external:USDC", amountCents: 5 }, { account: "fees:fees", amountCents: -4 }]), /sum to zero/);
    await assert.rejects(post([{ account: "card:a", amountCents: 0 }, { account: "fees:fees", amountCents: 0 }]), LedgerError);
    await assert.rejects(post([{ account: "card:a", amountCents: 1.5 }, { account: "fees:fees", amountCents: -1.5 }]), LedgerError);
    await assert.rejects(post([{ account: "card:a", amountCents: 5 }]), LedgerError);
    await assert.rejects(post([{ account: ":a", amountCents: 5 }, { account: "fees:fees", amountCents: -5 }]), /bad account/);
    await assert.rejects(post([{ account: "card:", amountCents: 5 }, { account: "fees:fees", amountCents: -5 }]), /bad account/);
    await assert.rejects(post([{ account: "fees:fees", amountCents: 5 }, { account: "external:USDC", amountCents: -5 }], { idempotencyKey: " " }), LedgerError);
    await assert.rejects(post([{ account: "fees:fees", amountCents: 5 }, { account: "external:USDC", amountCents: -5 }], { kind: "" }), LedgerError);
    const big = Number.MAX_SAFE_INTEGER;
    await assert.rejects(post([{ account: "external:a", amountCents: big }, { account: "external:b", amountCents: big }, { account: "external:c", amountCents: -big }, { account: "external:d", amountCents: -big }]), /safe integer/);
  });

  t("same key with different content or reference is rejected, posting order is irrelevant", async (l) => {
    await l.confirmDeposit(dep);
    await assert.rejects(l.confirmDeposit({ ...dep, amountCents: 20_000 }), /idempotency key reused/);
    const ps = [{ account: "external:USDC", amountCents: -5 }, { account: "fees:fees", amountCents: 5 }];
    const a = await l.post({ idempotencyKey: "k", kind: "x", reference: "r", postings: ps });
    const b = await l.post({ idempotencyKey: "k", kind: "x", reference: "r", postings: [...ps].reverse() });
    assert.equal(a.seq, b.seq);
    await assert.rejects(l.post({ idempotencyKey: "k", kind: "x", reference: "other", postings: ps }), /idempotency key reused/);
  });

  t("a failed transaction leaves no partial state", async (l) => {
    await l.confirmDeposit(dep);
    await assert.rejects(l.post({
      idempotencyKey: "bad", kind: "x",
      postings: [{ account: accounts.holding("c1"), amountCents: -5_000 }, { account: accounts.holding("c1"), amountCents: -6_000 }, { account: accounts.card("c1"), amountCents: 11_000 }],
    }));
    assert.equal(await l.balance(accounts.holding("c1")), 10_000);
    assert.equal((await l.history(accounts.holding("c1"))).length, 1);
  });

  t("a caller-supplied seq cannot overwrite the assigned one, and results are immutable", async (l) => {
    const tx = await l.post({ idempotencyKey: "k", kind: "x", seq: 99, postings: [{ account: "external:USDC", amountCents: -5 }, { account: "fees:fees", amountCents: 5 }] } as never);
    assert.equal(tx.seq, 1);
    assert.throws(() => { (tx.postings[0] as { amountCents: number }).amountCents = 1; });
    assert.throws(() => { tx.postings.push({ account: "a:b", amountCents: 1 }); });
    const [h] = await l.history("fees:fees");
    assert.throws(() => { (h as { kind: string }).kind = "y"; });
  });

  t("reversal negates the original once, never a reversal, and respects overdraft", async (l) => {
    const d = await l.confirmDeposit(dep);
    const r = await l.reverse({ seq: d.seq });
    assert.equal(r.kind, "reversal");
    assert.equal(r.reversesSeq, d.seq);
    assert.equal(await l.balance(accounts.holding("c1")), 0);
    assert.equal(await l.balance(accounts.external("USDC")), 0);
    assert.equal((await l.reverse({ seq: d.seq })).seq, r.seq);
    await assert.rejects(l.reverse({ seq: r.seq }), /reversal cannot be reversed/);
    await assert.rejects(l.reverse({ seq: 999 }), /no transaction/);

    const d2 = await l.confirmDeposit({ ...dep, txHash: "0x2" });
    await l.reserveFunding({ cardId: "c1", amountCents: 10_000, fundingId: "f1" });
    await assert.rejects(l.reverse({ seq: d2.seq }), /insufficient funds/);
    assert.equal(await l.balance(accounts.holding("c1")), 0);
  });

  t("concurrent reversals of one transaction apply once", async (l) => {
    const d = await l.confirmDeposit(dep);
    const out = await Promise.all(Array.from({ length: 6 }, () => l.reverse({ seq: d.seq })));
    assert.equal(new Set(out.map((o) => o.seq)).size, 1);
    assert.equal(await l.balance(accounts.holding("c1")), 0);
  });

  t("reverse validates seq, ignores nothing but refuses funding transactions", async (l) => {
    for (const seq of [1.5, NaN, 0, -1, Infinity]) await assert.rejects(l.reverse({ seq }), LedgerError);
    await l.confirmDeposit(dep);
    const rs = await l.reserveFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" });
    const rel = await l.releaseFunding({ cardId: "c1", amountCents: 5_000, fundingId: "f1" });
    await assert.rejects(l.reverse({ seq: rs.seq }), /funding transactions cannot be reversed/);
    await assert.rejects(l.reverse({ seq: rel.seq }), /funding transactions cannot be reversed/);
  });

  t("only allowlisted assets can be deposited", async (l) => {
    for (const asset of ["FAKECOIN", "merchant", "usdc", ""]) await assert.rejects(l.confirmDeposit({ ...dep, asset }), LedgerError);
    await l.confirmDeposit({ ...dep, asset: "USDT", txHash: "0x9" });
    assert.equal(await l.balance(accounts.merchant()), 0);
  });

  t("raw post cannot mint, move held funds or forge helper kinds", async (l) => {
    const two = (a: string, b: string, kind = "adj") => ({ idempotencyKey: `k-${a}-${kind}`, kind, postings: [{ account: a, amountCents: -5 }, { account: b, amountCents: 5 }] });
    await assert.rejects(l.post(two("external:made-up", "holding:c1")), /raw post cannot touch/);
    await assert.rejects(l.post(two("external:USDC", "holding:c1")), /raw post cannot touch/);
    await assert.rejects(l.post(two("external:USDC", "fees:fees", "funding")), /reserved/);
    await assert.rejects(l.post(two("external:USDC", "fees:fees", "deposit")), /reserved/);
    await l.post(two("external:USDC", "fees:fees"));
    assert.equal(await l.balance(accounts.fees()), 5);
  });

  t("checkout settlement credits a merchant once; refunds and payouts cannot overdraw it", async (l) => {
    const m = { merchantId: "m_1", checkoutId: "cs_1", amountCents: 1_000 };
    const a = await l.settleCheckout(m);
    assert.equal((await l.settleCheckout(m)).seq, a.seq);
    await assert.rejects(l.settleCheckout({ ...m, amountCents: 999 }), /different content/);
    assert.equal(await l.balance(accounts.merchantBalance("m_1")), 1_000);

    await assert.rejects(l.reservePayout({ merchantId: "m_1", amountCents: 1_001, payoutId: "p0" }), /insufficient/);
    await l.reservePayout({ merchantId: "m_1", amountCents: 800, payoutId: "p1" });
    await assert.rejects(l.completePayout({ merchantId: "m_1", amountCents: 799, payoutId: "p1" }), /no matching reservation/);
    await assert.rejects(l.completePayout({ merchantId: "m_1", amountCents: 800, payoutId: "nope" }), /no matching reservation/);
    await l.completePayout({ merchantId: "m_1", amountCents: 800, payoutId: "p1" });
    await assert.rejects(l.releasePayout({ merchantId: "m_1", amountCents: 800, payoutId: "p1" }), /already settled/);
    const p1 = await l.findByKey("payout-reserve:p1");
    await assert.rejects(l.reverse({ seq: p1!.seq }), /payout transactions cannot be reversed/);
    assert.equal(await l.balance(accounts.payouts()), 800);

    await assert.rejects(l.refundCheckout({ ...m, amountCents: 300 }), /insufficient/, "paid out already");
    await assert.rejects(l.refundCheckout({ ...m, checkoutId: "cs_other", amountCents: 100 }), /not settled/);
    await l.refundCheckout({ ...m, amountCents: 200 });
    await assert.rejects(l.reverse({ seq: a.seq }), /checkout transactions cannot be reversed/);
    await assert.rejects(l.reverse({ seq: (await l.findByKey("checkout-refund:cs_1"))!.seq }), /checkout transactions cannot be reversed/);
    await assert.rejects(l.refundCheckout({ ...m, amountCents: 100 }), /different content/, "one refund per checkout");
    assert.equal(await l.balance(accounts.merchantBalance("m_1")), 0);

    const two = (kind: string) => ({ idempotencyKey: `k-${kind}`, kind, postings: [{ account: "external:merchant", amountCents: -5 }, { account: "fees:fees", amountCents: 5 }] });
    for (const kind of ["checkout_settle", "payout", "payout_reserve"]) await assert.rejects(l.post(two(kind)), /reserved/);
    await assert.rejects(l.post({ idempotencyKey: "k-mint", kind: "adj", postings: [{ account: "external:merchant", amountCents: -5 }, { account: "merchant:m_1", amountCents: 5 }] }), /raw post cannot touch/);
  });

  t("reversal replay is idempotent", async (l) => {
    const d = await l.confirmDeposit(dep);
    const a = await l.reverse({ seq: d.seq });
    assert.equal((await l.reverse({ seq: d.seq })).seq, a.seq);
  });

  t("all balances sum to zero after a full lifecycle", async (l) => {
    await l.confirmDeposit(dep);
    await l.confirmDeposit({ ...dep, asset: "USDT", txHash: "0xdef", amountCents: 2_500 });
    await l.reserveFunding({ cardId: "c1", amountCents: 10_000, fundingId: "f1" });
    await l.completeFunding({ cardId: "c1", amountCents: 10_000, feeCents: 50, fundingId: "f1" });
    await l.reserveFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f2" });
    await l.releaseFunding({ cardId: "c1", amountCents: 1_000, fundingId: "f2" });
    await l.recordSpend({ cardId: "c1", amountCents: 3_000, spendId: "s1" });
    const names = ["external:USDC", "external:USDT", "external:merchant", "holding:c1", "pending:c1", "card:c1", "fees:fees"];
    let sum = 0;
    for (const n of names) sum += await l.balance(n);
    assert.equal(sum, 0);
  });
}

if (databaseUrl) {
  test("[postgres] survives restart and rejects tampering at the database", async () => {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    await admin!.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    const open = () => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    const p1 = open();
    await migrate(p1);
    await new Ledger(undefined, createLedgerStore(createDatabase(p1))).confirmDeposit(dep);
    await p1.end();

    const p2 = open();
    await migrate(p2); // idempotent
    const s2 = createLedgerStore(createDatabase(p2));
    const l2 = new Ledger(undefined, s2);
    assert.equal(await l2.balance(accounts.holding("c1")), 10_000);
    assert.equal((await l2.confirmDeposit(dep)).seq, 1);
    assert.equal((await l2.history(accounts.holding("c1"))).length, 1);

    const raw = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 });
    await assert.rejects(raw.query("UPDATE ledger_posting SET amount_cents = 1"), /append-only/);
    await assert.rejects(raw.query("DELETE FROM ledger_tx"), /append-only/);
    await assert.rejects(raw.query("TRUNCATE ledger_posting"), /append-only/);
    await assert.rejects(raw.query("UPDATE ledger_balance SET balance_cents = balance_cents - 10001 WHERE account = 'holding:c1'"), /no_overdraft/);
    await raw.query("UPDATE ledger_balance SET balance_cents = balance_cents + 1 WHERE account = 'external:USDC'");
    assert.equal((await s2.checkIntegrity()).length > 0, true, "integrity probe must notice a drifted balance");
    await raw.end();
    await p2.end();
  });
}
