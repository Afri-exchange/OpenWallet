import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { parseUsdCents, type CardDetails, type CheckoutFiller, type FillRequest, type FillResult } from "../src/checkout-swap/filler.js";
import { ShopifyFiller } from "../src/checkout-swap/shopify-filler.js";
import { startShopifyFixture, type ShopifyFixture } from "../src/checkout-swap/shopify-fixture.js";
import { checkoutKind, RoutingFiller } from "../src/checkout-swap/router-filler.js";

const TEST_CARD: CardDetails = { pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: 2030, nameOnCard: "Ada Test", billingZip: "94107" };
const WITH_ADDRESS: CardDetails = { ...TEST_CARD, billingAddress: { line1: "510 Townsend St", city: "San Francisco", state: "CA", country: "US" } };

test("shopify: only US dollars are read as dollars", () => {
  assert.equal(parseUsdCents("$10.00 USD"), 1000);
  assert.equal(parseUsdCents("US$10.00"), 1000);
  assert.equal(parseUsdCents("CA$10.00 CAD"), undefined);
  assert.equal(parseUsdCents("A$10"), undefined);
});

test("shopify: checkout pages are routed by their path, Stripe by host", () => {
  assert.equal(checkoutKind("https://checkout.stripe.com/c/pay/cs_test_a1"), "stripe");
  assert.equal(checkoutKind("https://buy.stripe.com/test_abc"), "stripe");
  assert.equal(checkoutKind("https://acme.myshopify.com/checkouts/cn/Z2abc"), "shopify");
  assert.equal(checkoutKind("https://shop.acme.com/12345/checkouts/abc"), "shopify");
  assert.equal(checkoutKind("https://acme.myshopify.com/products/hat"), undefined);
  assert.equal(checkoutKind("not a url"), undefined);
});

test("shopify: the router sends each page to its own filler and refuses the rest unopened", async () => {
  const seen: string[] = [];
  const mk = (name: string): CheckoutFiller => ({ fill: async (r: FillRequest): Promise<FillResult> => (seen.push(`${name}:${r.url}`), { outcome: "succeeded", submitted: true }) });
  const router = new RoutingFiller({ stripe: mk("stripe"), shopify: mk("shopify") });
  const base = { expectedAmountCents: 1, card: { ...TEST_CARD }, email: "o@example.com" };
  await router.fill({ ...base, url: "https://checkout.stripe.com/c/pay/cs_test_a1" });
  await router.fill({ ...base, url: "https://acme.myshopify.com/checkouts/cn/abc" });
  const other = await router.fill({ ...base, url: "https://acme.myshopify.com/cart" });
  assert.deepEqual(seen, ["stripe:https://checkout.stripe.com/c/pay/cs_test_a1", "shopify:https://acme.myshopify.com/checkouts/cn/abc"]);
  assert.deepEqual([other.outcome, other.submitted], ["unsupported_page", false]);
});

// ---------- the real browser against the local Shopify-like fixture ----------

const browserSkip = process.env.SKIP_BROWSER === "1";
let fx: ShopifyFixture | undefined;
let browser: import("playwright-core").Browser | undefined;
before(async () => {
  if (browserSkip) return;
  fx = await startShopifyFixture();
  browser = await (await import("playwright-core")).chromium.launch();
});
after(async () => {
  await browser?.close();
  await fx?.close();
});
const fillAt = (scenario: string, o: { amount?: number; expected?: number; card?: CardDetails; resultTimeoutMs?: number } = {}) =>
  new ShopifyFiller({ browser, resultTimeoutMs: o.resultTimeoutMs ?? 5_000, loadTimeoutMs: 10_000 }).fill({
    url: fx!.url(scenario, o.amount ?? 1000), expectedAmountCents: o.expected ?? 1000, card: o.card ?? { ...TEST_CARD }, email: "owner@example.com",
  });

test("shopify filler: digital goods, the card reaches the iframes and the thank-you page counts as paid", { skip: browserSkip }, async () => {
  for (const s of ["success", "rowtotal"]) {
    const r = await fillAt(s);
    assert.deepEqual([s, r.outcome, r.submitted, r.pageAmountCents], [s, "succeeded", true, 1000]);
  }
  const sub = fx!.submissions.at(-1)!;
  assert.equal(sub.last4, "4242", "the card went into the cross-origin iframe");
  assert.equal(sub.fields.email, "owner@example.com");
  assert.equal(sub.fields.expiry, "1230");
  assert.equal(sub.fields.cvvLength, "3");
  assert.equal(sub.fields.name, "Ada Test");
});

test("shopify filler: an address is typed from the card's billing address, or the run stops before paying", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const bare = await fillAt("shipping");
  assert.deepEqual([bare.outcome, bare.submitted], ["unsupported_page", false]);
  assert.match(bare.detail!, /address/);
  assert.equal(fx!.submissions.length, before, "nothing sent");
  const ok = await fillAt("shipping", { card: WITH_ADDRESS });
  assert.deepEqual([ok.outcome, ok.submitted], ["succeeded", true]);
  assert.equal(fx!.submissions.at(-1)!.fields.address1, "510 Townsend St");
  assert.equal(fx!.submissions.at(-1)!.fields.country, "US");
  const wrongCountry = await fillAt("shipping", { card: { ...WITH_ADDRESS, billingAddress: { line1: "1 Rue", city: "Paris", country: "FR" } } });
  assert.deepEqual([wrongCountry.outcome, wrongCountry.submitted], ["unsupported_page", false], "never type a French address into a form with no France");
});

test("shopify filler: a multi-page checkout is walked through to the card fields", { skip: browserSkip }, async () => {
  const r = await fillAt("multistep", { card: WITH_ADDRESS });
  assert.deepEqual([r.outcome, r.submitted, r.pageAmountCents], ["succeeded", true, 1000]);
});

test("shopify filler: a price that differs, at load or after shipping is added, stops before the card is typed", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const atLoad = await fillAt("success", { amount: 1200 });
  assert.deepEqual([atLoad.outcome, atLoad.submitted, atLoad.pageAmountCents], ["amount_mismatch", false, 1200]);
  const afterShipping = await fillAt("pricechange", { card: WITH_ADDRESS });
  assert.deepEqual([afterShipping.outcome, afterShipping.submitted, afterShipping.pageAmountCents], ["amount_mismatch", false, 1500]);
  assert.equal(fx!.submissions.length, before, "no card ever reached the page");
  assert.equal((await fillAt("nototal")).outcome, "unsupported_page");
  const foreign = await fillAt("foreign");
  assert.deepEqual([foreign.outcome, foreign.submitted], ["unsupported_page", false], "CA$10.00 is not $10.00");
});

test("shopify filler: decline, captcha, 3-D Secure and a silent page are told apart, with no card in the result", { skip: browserSkip }, async () => {
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

test("shopify filler: Bogus Gateway rules (card 1 pays, 2 declines, 3 raises) behave as documented", { skip: browserSkip }, async () => {
  const bogus = (pan: string) => fillAt("bogus", { card: { ...TEST_CARD, pan }, resultTimeoutMs: 2_000 });
  assert.deepEqual((await bogus("1")).outcome, "succeeded");
  assert.deepEqual((await bogus("2")).outcome, "declined");
  const exc = await bogus("3");
  assert.deepEqual([exc.outcome, exc.submitted], ["error", true], "a gateway exception is not a decline: charge state unknown");
});
