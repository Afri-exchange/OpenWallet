import type { Browser, Frame, Locator, Page } from "playwright-core";
import { parseUsdCents, type CheckoutFiller, type FillRequest, type FillResult } from "./filler.js";
import { THREE_DS_FRAME, captchaShown, cardFree, digits, hasFrame, isEditable, pad2, usd } from "./playwright-filler.js";

/**
 * Fills a Lemon Squeezy checkout (https://<store>.lemonsqueezy.com/checkout/buy/<uuid>, or /checkout/custom/<id>) in
 * headless Chromium. Same contract as the other fillers: check the price first, type the card as late as possible,
 * report an outcome without page content.
 *
 * What differs:
 *  - Lemon Squeezy is the merchant of record, so TAX is added once a billing country and ZIP are known. The price is
 *    checked at load and again after the billing block is filled, before the card is typed.
 *  - The card goes into Stripe Elements iframes: either one frame holding number + expiry + cvc, or one per field.
 *    Frames are found by the input inside them, so both layouts work.
 *  - Card details are only a card, email, country and ZIP: no delivery address.
 *
 * The selectors come from what we know of Lemon Squeezy's checkout, NOT from a live store (docs/checkout-swap.md,
 * "Lemon Squeezy"). lemonsqueezy-fixture.ts mirrors them, so tests prove the logic, not the selectors.
 */

export interface LemonSqueezyFillerOptions {
  headless?: boolean;
  loadTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** For tests: an already launched browser (not closed by the filler). */
  browser?: Browser;
}

const SEL = {
  totals: ['[data-testid="order-total"]', '[data-test="order-total"]', '[role="row"]:has([role="rowheader"]:text-is("Total")) [role="cell"]'],
  email: 'input[name="email"], input#email',
  name: 'input[name="name"], input[name="billing_name"]',
  country: 'select[name="country"], select[name="billing_address.country"], select[name="billing_country"]',
  zip: 'input[name="zip"], input[name="postal_code"], input[name="billing_address.zip"]',
  /** Inputs inside Stripe's iframes (classic Elements, then Payment Element). */
  number: 'input[name="cardnumber"], input[name="number"]',
  expiry: 'input[name="exp-date"], input[name="expiry"]',
  cvc: 'input[name="cvc"]',
  pay: 'button[type="submit"]:has-text("Pay"), button[data-testid="submit-button"]',
  error: '[role="alert"], [data-testid="payment-error"]',
  confirmed: '[data-testid="order-confirmation"]',
};
const CONFIRMED_URL = /\/(?:thank[-_]?you|confirmation|receipt)(?:[/?#]|$)|\/my-orders\//i;

export class LemonSqueezyFiller implements CheckoutFiller {
  constructor(private readonly o: LemonSqueezyFillerOptions = {}) {}

  async fill(req: FillRequest): Promise<FillResult> {
    const own = !this.o.browser;
    const browser = this.o.browser ?? (await (await import("playwright-core")).chromium.launch({ headless: this.o.headless ?? true }));
    // A fresh context per attempt: no cookies, storage or autofill carried between payments.
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    let submitted = false;
    try {
      const page = await context.newPage();
      return await this.run(page, req, () => (submitted = true));
    } catch (e) {
      return { outcome: "error", submitted, detail: cardFree(e, req) };
    } finally {
      await context.close().catch(() => undefined);
      if (own) await browser.close().catch(() => undefined);
    }
  }

  private async run(page: Page, req: FillRequest, markSubmitted: () => void): Promise<FillResult> {
    const loadMs = this.o.loadTimeoutMs ?? 30_000;
    const c = req.card;

    await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: loadMs });
    await page.locator(SEL.email).first().waitFor({ state: "visible", timeout: loadMs }).catch(() => undefined);
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, detail: "bot check shown before the checkout form" };

    const first = await readTotal(page, Math.min(loadMs, 15_000));
    if (first.kind === "none") return { outcome: "unsupported_page", submitted: false, detail: "no readable total on the page" };
    if (first.kind === "foreign") return { outcome: "unsupported_page", submitted: false, detail: "the checkout total is not in US dollars" };
    if (first.cents !== req.expectedAmountCents) return mismatch(first.cents, req.expectedAmountCents);

    // Contact + billing. The country and ZIP are what tax is worked out from.
    const email = page.locator(SEL.email).first();
    if (await isEditable(email)) await email.fill(req.email);
    const nameField = page.locator(SEL.name).first();
    if (await isEditable(nameField)) await nameField.fill(c.nameOnCard?.trim() || "Card Holder");
    const country = page.locator(SEL.country).first();
    if ((await country.count()) > 0) {
      const want = c.billingAddress?.country || "US";
      // Never bill one country's card into another country's tax.
      if (!(await selectOne(country, want))) return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: `the checkout does not offer the card's billing country (${want})` };
      await page.waitForTimeout(400);
    }
    const zip = page.locator(SEL.zip).first();
    if (await zip.isVisible().catch(() => false)) {
      if (!c.billingZip) return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "the checkout asks for a postal code and none is on file for this card" };
      await zip.fill(c.billingZip);
      await page.waitForTimeout(400);
    }

    if (!(await cardFrame(page, SEL.number, 15_000))) return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "card number field not found" };
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, pageAmountCents: first.cents, detail: "bot check shown before the card form" };

    // Tax is known now. The price the agent agreed to must still be the price.
    const settled = await readTotal(page, 5_000);
    if (settled.kind !== "ok") return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "the total became unreadable after the billing step" };
    if (settled.cents !== req.expectedAmountCents) return mismatch(settled.cents, req.expectedAmountCents);

    // The card goes in only now.
    const missing = await this.typeCard(page, req);
    if (missing) return { outcome: "unsupported_page", submitted: false, pageAmountCents: settled.cents, detail: missing };

    const pay = page.locator(SEL.pay).first();
    if (!(await payReady(pay, 15_000))) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents: settled.cents, detail: "the pay button never became ready; the page may want a field we do not have" };
    }
    const last = await readTotal(page, 2_000);
    if (last.kind !== "ok" || last.cents !== req.expectedAmountCents) {
      return { outcome: "amount_mismatch", submitted: false, pageAmountCents: last.kind === "ok" ? last.cents : settled.cents, detail: "the total changed while the form was being filled" };
    }
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, pageAmountCents: settled.cents, detail: "bot check shown before submit" };
    markSubmitted();
    await pay.click({ timeout: 10_000 });
    return this.watch(page, settled.cents);
  }

  /** Types the card into Stripe's iframes. Returns a reason when a field is missing, else undefined. */
  private async typeCard(page: Page, req: FillRequest): Promise<string | undefined> {
    const c = req.card;
    const type = async (sel: string, text: string) => {
      const frame = await cardFrame(page, sel, 5_000);
      if (!frame) return false;
      const input = frame.locator(sel).first();
      await input.click();
      await input.pressSequentially(text, { delay: 15 });
      return true;
    };
    if (!(await type(SEL.number, digits(c.pan)))) return "card number field not found";
    if (!(await type(SEL.expiry, `${pad2(c.expMonth)}${String(c.expYear).slice(-2)}`))) return "expiry field not found";
    if (!(await type(SEL.cvc, digits(c.cvv)))) return "security code field not found";
    return undefined;
  }

  /** After pressing pay: confirmation, a decline message, a challenge, or a timeout (unknown). */
  private async watch(page: Page, pageAmountCents: number): Promise<FillResult> {
    const deadline = Date.now() + (this.o.resultTimeoutMs ?? 60_000);
    const done = (outcome: FillResult["outcome"], detail: string): FillResult => ({ outcome, submitted: true, pageAmountCents, detail });
    while (Date.now() < deadline) {
      if (CONFIRMED_URL.test(safePath(page.url())) || (await page.locator(SEL.confirmed).first().isVisible().catch(() => false))) return done("succeeded", "order confirmation shown");
      if (hasFrame(page, THREE_DS_FRAME)) return done("three_ds", "3-D Secure challenge shown after submit");
      if (await captchaShown(page)) return done("captcha", "bot check shown after submit");
      const err = page.locator(SEL.error).first();
      if (await err.isVisible().catch(() => false)) {
        // Only the decline wording is matched; the message itself is not stored (it can echo field content).
        const text = (await err.innerText().catch(() => "")).toLowerCase();
        if (/declin|insufficient|do not honou?r|not supported|incorrect|invalid|could not be processed|failed/.test(text)) return done("declined", "page shows a card decline");
      }
      await page.waitForTimeout(500);
    }
    return done("error", "no result shown before the timeout; the charge state is unknown");
  }
}

type Total = { kind: "ok"; cents: number } | { kind: "foreign" } | { kind: "none" };

/** The order total, polled. A total in another currency is "foreign", never read as dollars. */
async function readTotal(page: Page, waitMs: number): Promise<Total> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const sel of SEL.totals) {
      const l = page.locator(sel).last();
      const text = (await l.count()) > 0 ? await l.innerText({ timeout: 2_000 }).catch(() => "") : "";
      if (!text) continue;
      if (/\b(?!USD\b)[A-Z]{3}\b/.test(text) || /[€£¥₦₹]/.test(text)) return { kind: "foreign" };
      const cents = parseUsdCents(text);
      if (cents !== undefined) return { kind: "ok", cents };
    }
    if (Date.now() >= deadline) return { kind: "none" };
    await page.waitForTimeout(250);
  }
}

/** The (cross-origin) frame that holds the given input, polled: Stripe mounts its frames after the page. */
async function cardFrame(page: Page, sel: string, waitMs: number): Promise<Frame | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const f of page.frames()) {
      if (f !== page.mainFrame() && (await f.locator(sel).first().isVisible().catch(() => false))) return f;
    }
    if (Date.now() >= deadline) return undefined;
    await page.waitForTimeout(250);
  }
}

async function payReady(pay: Locator, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ok = (await pay.isVisible().catch(() => false)) && (await pay.isEnabled().catch(() => false)) && (await pay.getAttribute("aria-disabled").catch(() => null)) !== "true";
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await pay.page().waitForTimeout(250);
  }
}

const mismatch = (page: number, expected: number): FillResult => ({ outcome: "amount_mismatch", submitted: false, pageAmountCents: page, detail: `page total ${usd(page)}, expected ${usd(expected)}` });
const safePath = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return "";
  }
};
/** A select matches on value or on label ("NG" or "Nigeria"). */
const selectOne = (l: Locator, v: string) => l.selectOption([{ value: v }, { label: v }], { timeout: 3_000 }).then((r) => r.length > 0, () => false);
