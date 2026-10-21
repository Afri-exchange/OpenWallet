// Rehearses the checkout swap filler in real headless Chromium, with a TEST card only. No database, no Miden, no secrets.
//
//   tsx scripts/swap-rehearsal.ts                                   every scenario against the local Stripe-like fixture
//   tsx scripts/swap-rehearsal.ts --url <stripe TEST url> --amount 10.00 [--headed] [--miden-address]
//                                                                    one run against a real Stripe test-mode Checkout
//                                                                    (cs_test_...) or Payment Link (buy.stripe.com/test_...)
//
// The real-Stripe run uses Stripe's public test card 4242 4242 4242 4242 and refuses any URL that is not test mode,
// so it can never charge anyone. --miden-address swaps the US address for a Nigerian one in the shape Miden's full-PAN
// billingDetails returns (alpha-2 country, state as a name), mapped through toBillingAddress like a real capture.
// It proves our selectors, price check and result detection still match Stripe's page.
import { PlaywrightFiller } from "../src/checkout-swap/playwright-filler.js";
import { startCheckoutFixture } from "../src/checkout-swap/fixture.js";
import { DEFAULT_SWAP_HOSTS } from "../src/checkout-swap/swap.js";
import type { CardDetails } from "../src/vault/vault.js";
import { toBillingAddress } from "../src/miden/card-details.js";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const STRIPE_TEST_CARD = (): CardDetails => ({ pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: new Date().getUTCFullYear() + 3, nameOnCard: "Rehearsal Test", billingZip: "94107",
  billingAddress: { line1: "510 Townsend St", city: "San Francisco", state: "CA", country: "US" } });
// Synthetic, not anyone's real KYC address; same fields and formats as the sandbox card's billingDetails.
const MIDEN_SHAPED = { addressLine1: "12 Admiralty Way", addressLine2: "Lekki Phase 1", city: "Lekki", state: "Lagos", zipCode: "106104", country: "NG" };
const rehearsalCard = (): CardDetails => {
  const c = STRIPE_TEST_CARD();
  if (!args.includes("--miden-address")) return c;
  return { ...c, billingZip: MIDEN_SHAPED.zipCode, billingAddress: toBillingAddress(MIDEN_SHAPED) };
};
const email = process.env.SWAP_RECEIPT_EMAIL ?? "rehearsal@example.com";

const url = arg("--url");
if (url) {
  const u = new URL(url);
  if (!DEFAULT_SWAP_HOSTS.includes(u.host)) throw new Error(`not a Stripe checkout host: ${u.host}`);
  if (!/cs_test_|\/test_/.test(u.pathname + u.hash)) throw new Error("rehearsal only runs against Stripe TEST mode (cs_test_... or buy.stripe.com/test_...)");
  const dollars = Number(arg("--amount"));
  if (!(dollars > 0)) throw new Error("--amount <dollars> is required: the exact total on the page");
  const filler = new PlaywrightFiller({ headless: !args.includes("--headed"), loadTimeoutMs: 45_000, resultTimeoutMs: 90_000 });
  const r = await filler.fill({ url, expectedAmountCents: Math.round(dollars * 100), card: rehearsalCard(), email });
  console.log(`stripe test checkout: ${r.outcome}${r.submitted ? " (submitted)" : ""}${r.detail ? `: ${r.detail}` : ""}`);
  process.exitCode = r.outcome === "succeeded" ? 0 : 1;
} else {
  const fx = await startCheckoutFixture();
  const filler = new PlaywrightFiller({ resultTimeoutMs: 4_000, loadTimeoutMs: 10_000 });
  const expect: [scenario: string, pageCents: number, outcome: string, submitted: boolean][] = [
    ["success", 1000, "succeeded", true],
    ["complete", 1000, "succeeded", true],
    ["accordion", 1000, "succeeded", true],
    ["address", 1000, "succeeded", true],
    ["success", 1250, "amount_mismatch", false],
    ["nototal", 1000, "unsupported_page", false],
    ["decline", 1000, "declined", true],
    ["captcha", 1000, "captcha", false],
    ["three_ds", 1000, "three_ds", true],
    ["hang", 1000, "error", true],
  ];
  let bad = 0;
  try {
    for (const [scenario, pageCents, outcome, submitted] of expect) {
      const r = await filler.fill({ url: fx.url(scenario, pageCents), expectedAmountCents: 1000, card: STRIPE_TEST_CARD(), email });
      const ok = r.outcome === outcome && r.submitted === submitted;
      if (!ok) bad++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${scenario.padEnd(10)} -> ${r.outcome}${r.submitted ? " (submitted)" : ""}${ok ? "" : `   expected ${outcome}${submitted ? " (submitted)" : ""}`}`);
    }
  } finally {
    await fx.close();
  }
  console.log(bad ? `${bad} scenario(s) failed` : "all scenarios pass");
  process.exitCode = bad ? 1 : 0;
}
