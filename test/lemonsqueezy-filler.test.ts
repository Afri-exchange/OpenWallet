import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import type { CardDetails, CheckoutFiller, FillRequest, FillResult } from "../src/checkout-swap/filler.js";
import { LemonSqueezyFiller } from "../src/checkout-swap/lemonsqueezy-filler.js";
import { startLemonSqueezyFixture, type LemonSqueezyFixture } from "../src/checkout-swap/lemonsqueezy-fixture.js";
import { checkoutKind, RoutingFiller } from "../src/checkout-swap/router-filler.js";

const TEST_CARD: CardDetails = { pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: 2030, nameOnCard: "Ada Test", billingZip: "94107" };

test("lemonsqueezy: checkout pages are routed by host + path, other pages and look-alike hosts are not", () => {
  assert.equal(checkoutKind("https://acme.lemonsqueezy.com/checkout/buy/3f2a-b1"), "lemonsqueezy");
  assert.equal(checkoutKind("https://acme.lemonsqueezy.com/checkout/custom/abc?signature=x"), "lemonsqueezy");
  assert.equal(checkoutKind("https://acme.lemonsqueezy.com/products/hat"), undefined);
  assert.equal(checkoutKind("https://evil-lemonsqueezy.com/checkout/buy/x"), undefined);
  assert.equal(checkoutKind("https://lemonsqueezy.com.evil.io/checkout/buy/x"), undefined);
  assert.equal(checkoutKind("https://checkout.stripe.com/c/pay/cs_test_a1"), "stripe");
  assert.equal(checkoutKind("https://acme.myshopify.com/checkouts/cn/abc"), "shopify");
});

test("lemonsqueezy: the router sends the page to its filler", async () => {
  const seen: string[] = [];
  const mk = (name: string): CheckoutFiller => ({ fill: async (r: FillRequest): Promise<FillResult> => (seen.push(`${name}:${r.url}`), { outcome: "succeeded", submitted: true }) });
  const router = new RoutingFiller({ stripe: mk("stripe"), shopify: mk("shopify"), lemonsqueezy: mk("ls") });
  await router.fill({ url: "https://acme.lemonsqueezy.com/checkout/buy/abc", expectedAmountCents: 1, card: { ...TEST_CARD }, email: "o@example.com" });
  assert.deepEqual(seen, ["ls:https://acme.lemonsqueezy.com/checkout/buy/abc"]);
});

const browserSkip = process.env.SKIP_BROWSER === "1";
let fx: LemonSqueezyFixture | undefined;
let browser: import("playwright-core").Browser | undefined;
before(async () => {
  if (browserSkip) return;
  fx = await startLemonSqueezyFixture();
  browser = await (await import("playwright-core")).chromium.launch();
});
after(async () => {
  await browser?.close();
  await fx?.close();
});
const fillAt = (scenario: string, o: { amount?: number; expected?: number; card?: CardDetails; resultTimeoutMs?: number } = {}) =>
  new LemonSqueezyFiller({ browser, resultTimeoutMs: o.resultTimeoutMs ?? 5_000, loadTimeoutMs: 10_000 }).fill({
    url: fx!.url(scenario, o.amount ?? 1000), expectedAmountCents: o.expected ?? 1000, card: o.card ?? { ...TEST_CARD }, email: "owner@example.com",
  });

test("lemonsqueezy filler: separate and combined card frames both get the card, and the confirmation counts as paid", { skip: browserSkip }, async () => {
  for (const s of ["success", "combined"]) {
    const r = await fillAt(s);
    assert.deepEqual([s, r.outcome, r.submitted, r.pageAmountCents], [s, "succeeded", true, 1000]);
    const sub = fx!.submissions.at(-1)!;
    assert.equal(sub.last4, "4242");
    assert.equal(sub.fields.email, "owner@example.com");
    assert.equal(sub.fields.expiry, "1230");
    assert.equal(sub.fields.cvcLength, "3");
    assert.equal(sub.fields.zip, "94107");
    assert.equal(sub.fields.country, "US");
  }
});

test("lemonsqueezy filler: a price that differs, or grows with tax, stops before the card is typed", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const atLoad = await fillAt("success", { amount: 1200 });
  assert.deepEqual([atLoad.outcome, atLoad.submitted, atLoad.pageAmountCents], ["amount_mismatch", false, 1200]);
  const taxed = await fillAt("tax");
  assert.deepEqual([taxed.outcome, taxed.submitted, taxed.pageAmountCents], ["amount_mismatch", false, 1100], "tax added after the ZIP is a different price");
  assert.equal((await fillAt("nototal")).outcome, "unsupported_page");
  const foreign = await fillAt("foreign");
  assert.deepEqual([foreign.outcome, foreign.submitted], ["unsupported_page", false], "€10.00 is not $10.00");
  assert.equal(fx!.submissions.length, before, "no card ever reached the page");
});

test("lemonsqueezy filler: a billing country the page does not offer stops the run", { skip: browserSkip }, async () => {
  const r = await fillAt("success", { card: { ...TEST_CARD, billingAddress: { line1: "1 Rue", city: "Paris", country: "FR" } } });
  assert.deepEqual([r.outcome, r.submitted], ["unsupported_page", false]);
});

test("lemonsqueezy filler: decline, captcha, 3-D Secure and a silent page are told apart, with no card in the result", { skip: browserSkip }, async () => {
  const d = await fillAt("decline");
  assert.deepEqual([d.outcome, d.submitted], ["declined", true]);
  const c = await fillAt("captcha");
  assert.deepEqual([c.outcome, c.submitted], ["captcha", false]);
  const t = await fillAt("three_ds");
  assert.deepEqual([t.outcome, t.submitted], ["three_ds", true]);
  const h = await fillAt("hang", { resultTimeoutMs: 1_500 });
  assert.deepEqual([h.outcome, h.submitted], ["error", true], "no answer after submit: unknown, never 'failed'");
  for (const r of [d, c, t, h]) assert.doesNotMatch(JSON.stringify(r), /4242424242424242|"123"/);
});
