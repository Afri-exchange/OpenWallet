import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import type { CardDetails, CheckoutFiller, FillRequest, FillResult } from "../src/adapters/checkoutFillers/CheckoutFiller.js";
import { PaddleFiller } from "../src/adapters/checkoutFillers/PaddleFiller.js";
import { startPaddleFixture, type PaddleFixture } from "../src/adapters/checkoutFillers/fixtures/paddleFixture.js";
import { checkoutKind, RoutingFiller } from "../src/adapters/checkoutFillers/RoutingFiller.js";

const TEST_CARD: CardDetails = { pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: 2030, nameOnCard: "Ada Test", billingZip: "94107" };
const WITH_ADDRESS: CardDetails = { ...TEST_CARD, billingAddress: { line1: "510 Townsend St", city: "San Francisco", state: "CA", country: "US" } };

test("paddle: hosted links, paddle.com frames and _ptxn links are routed to Paddle, other pages are not", () => {
  assert.equal(checkoutKind("https://pay.paddle.io/hsc_01abc_def"), "paddle");
  assert.equal(checkoutKind("https://sandbox-pay.paddle.io/hsc_01abc_def"), "paddle");
  assert.equal(checkoutKind("https://buy.paddle.com/checkout/abc"), "paddle");
  assert.equal(checkoutKind("https://acme.com/pay?_ptxn=txn_01abc"), "paddle");
  assert.equal(checkoutKind("https://acme.com/pricing"), undefined);
  assert.equal(checkoutKind("https://notpaddle.com/x"), undefined);
  assert.equal(checkoutKind("https://acme.myshopify.com/checkouts/cn/abc"), "shopify");
  assert.equal(checkoutKind("https://checkout.stripe.com/c/pay/cs_test_a1"), "stripe");
});

test("paddle: the router sends a Paddle page to the Paddle filler", async () => {
  const seen: string[] = [];
  const mk = (name: string): CheckoutFiller => ({ fill: async (r: FillRequest): Promise<FillResult> => (seen.push(`${name}:${r.url}`), { outcome: "succeeded", submitted: true }) });
  const router = new RoutingFiller({ stripe: mk("stripe"), shopify: mk("shopify"), lemonsqueezy: mk("lemonsqueezy"), paddle: mk("paddle") });
  const base = { expectedAmountCents: 1, card: { ...TEST_CARD }, email: "o@example.com" };
  await router.fill({ ...base, url: "https://pay.paddle.io/hsc_01abc" });
  await router.fill({ ...base, url: "https://checkout.stripe.com/c/pay/cs_test_a1" });
  assert.deepEqual(seen, ["paddle:https://pay.paddle.io/hsc_01abc", "stripe:https://checkout.stripe.com/c/pay/cs_test_a1"]);
});

// ---------- the real browser against the local Paddle-like fixture ----------

const browserSkip = process.env.SKIP_BROWSER === "1";
let fx: PaddleFixture | undefined;
let browser: import("playwright-core").Browser | undefined;
before(async () => {
  if (browserSkip) return;
  fx = await startPaddleFixture();
  browser = await (await import("playwright-core")).chromium.launch();
});
after(async () => {
  await browser?.close();
  await fx?.close();
});
const fillAt = (scenario: string, o: { amount?: number; expected?: number; card?: CardDetails; embedded?: boolean; resultTimeoutMs?: number } = {}) =>
  new PaddleFiller({ browser, resultTimeoutMs: o.resultTimeoutMs ?? 5_000, loadTimeoutMs: 10_000 }).fill({
    url: (o.embedded ? fx!.embedded : fx!.hosted)(scenario, o.amount ?? 1000),
    expectedAmountCents: o.expected ?? 1000,
    card: o.card ?? { ...WITH_ADDRESS },
    email: "owner@example.com",
  });

test("paddle filler: hosted checkout, the card and billing details reach the form and the success state counts as paid", { skip: browserSkip }, async () => {
  const r = await fillAt("success");
  assert.deepEqual([r.outcome, r.submitted, r.pageAmountCents], ["succeeded", true, 1000]);
  const sub = fx!.submissions.at(-1)!;
  assert.equal(sub.last4, "4242");
  assert.deepEqual([sub.fields.email, sub.fields.country, sub.fields.postal, sub.fields.expiry, sub.fields.cvvLength, sub.fields.name], ["owner@example.com", "US", "94107", "1230", "3", "Ada Test"]);
  const redirected = await fillAt("redirect");
  assert.deepEqual([redirected.outcome, redirected.submitted], ["succeeded", true]);
});

test("paddle filler: a checkout inside a merchant page's iframe is filled the same way", { skip: browserSkip }, async () => {
  const r = await fillAt("success", { embedded: true });
  assert.deepEqual([r.outcome, r.submitted, r.pageAmountCents], ["succeeded", true, 1000]);
  assert.equal(fx!.submissions.at(-1)!.last4, "4242");
});

test("paddle filler: tax is added after the billing step, and only the tax-inclusive amount is paid", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const short = await fillAt("tax", { amount: 1000, expected: 1000 });
  assert.deepEqual([short.outcome, short.submitted, short.pageAmountCents], ["amount_mismatch", false, 1080], "pre-tax amount agreed, tax pushed it up");
  assert.equal(fx!.submissions.length, before, "no card ever reached the page");
  const ok = await fillAt("tax", { amount: 1000, expected: 1080 });
  assert.deepEqual([ok.outcome, ok.submitted, ok.pageAmountCents], ["succeeded", true, 1080]);
});

test("paddle filler: a total above the agreed amount at load, an unreadable total and a foreign currency stop before anything is typed", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const high = await fillAt("success", { amount: 1200 });
  assert.deepEqual([high.outcome, high.submitted, high.pageAmountCents], ["amount_mismatch", false, 1200]);
  assert.equal((await fillAt("nototal")).outcome, "unsupported_page");
  const foreign = await fillAt("foreign");
  assert.deepEqual([foreign.outcome, foreign.submitted], ["unsupported_page", false], "€10.00 is not $10.00");
  assert.equal(fx!.submissions.length, before);
});

test("paddle filler: no billing country or postal code on file means it stops before typing, and a country the form lacks too", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const bare = await fillAt("success", { card: { ...TEST_CARD } });
  assert.deepEqual([bare.outcome, bare.submitted], ["unsupported_page", false]);
  assert.match(bare.detail!, /country and postal code/);
  const fr = await fillAt("success", { card: { ...WITH_ADDRESS, billingAddress: { line1: "1 Rue", city: "Paris", country: "FR" } } });
  assert.deepEqual([fr.outcome, fr.submitted], ["unsupported_page", false]);
  assert.equal(fx!.submissions.length, before);
});

test("paddle filler: decline, captcha, 3-D Secure and a silent page are told apart, with no card in the result", { skip: browserSkip }, async () => {
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
