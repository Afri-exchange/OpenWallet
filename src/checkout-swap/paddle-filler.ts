import type { Browser, FrameLocator, Locator, Page } from "playwright-core";
import { parseUsdCents, type CheckoutFiller, type FillRequest, type FillResult } from "./filler.js";
import { THREE_DS_FRAME, captchaShown, cardFree, digits, hasFrame, isEditable, pad2, usd } from "./playwright-filler.js";

/**
 * Fills a Paddle Billing checkout in headless Chromium: a hosted checkout (https://pay.paddle.io/hsc_...), or a
 * merchant page that opens Paddle's checkout in an iframe (a default payment link, https://<merchant>/...?_ptxn=txn_...).
 * Same contract as the Stripe and Shopify fillers: check the price before typing, type the card as late as possible,
 * report an outcome without page content.
 *
 * What differs:
 *  - Paddle is the merchant of record, so tax is added from the buyer's country and postal code. The total at load is
 *    often the pre-tax price. So the load check only refuses a total ABOVE the agreed amount; the authoritative
 *    check is the total after country and postal code are in, right before the card is typed (and again before pay).
 *  - Email, country and postal code come first, then "Continue", then the card form. The card's billing country and
 *    ZIP are used, because they decide the tax. Without them the run stops before anything is typed.
 *  - The checkout may be the page itself or an iframe inside it; the filler works out which.
 *
 * Selectors come from Paddle's checkout as we know it (labels and button names), NOT from a live Paddle account (see
 * docs/checkout-swap.md, "Paddle"). paddle-fixture.ts mirrors them, so tests prove the logic, not the selectors.
 */

export interface PaddleFillerOptions {
  headless?: boolean;
  loadTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** For tests: an already launched browser (not closed by the filler). */
  browser?: Browser;
}

/** Either the page (hosted checkout) or the Paddle iframe inside the merchant's page. Both answer the same queries. */
type Root = Page | FrameLocator;

const SEL = {
  frame: 'iframe[name="paddle_frame"], iframe.paddle-frame-overlay, iframe.paddle-frame-inline, iframe[src*="paddle.com"], iframe[src*="paddle.io"]',
  /** Tried in order; the first one that holds a readable amount wins. */
  totals: ['[data-testid="total-due-today"]', '[data-testid="total"]', '[role="row"]:has-text("Total due today") >> nth=-1'],
  email: 'input[type="email"], input[name="email"]',
  country: 'select[name="country"], select[name="countryCode"]',
  postal: 'input[name="postalCode"], input[name="zipCode"], input[name="postal_code"]',
  number: 'input[name="cardNumber"], input[autocomplete="cc-number"]',
  expiry: 'input[name="expiry"], input[autocomplete="cc-exp"]',
  cvv: 'input[name="cvv"], input[autocomplete="cc-csc"]',
  holder: 'input[name="cardholderName"], input[autocomplete="cc-name"]',
  error: '[role="alert"], [data-testid="error"]',
  success: '[data-testid="success"]',
};
const THANK_YOU = /\/(?:thank[-_]?you|success|confirmation|done)(?:[/?#]|$)/i;
const SUCCESS_TEXT = /payment (?:successful|complete|received)|thank you for your (?:purchase|payment)/i;
const DECLINE_TEXT = /declin|insufficient|do not honou?r|not supported|incorrect|invalid|could not be processed|failed/;
const THREE_DS_URL = /\/authentications\/|\/three_d_secure|\/3d_secure|3ds/i;

export class PaddleFiller implements CheckoutFiller {
  constructor(private readonly o: PaddleFillerOptions = {}) {}

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
    const addr = c.billingAddress;
    const startUrl = req.url;

    await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: loadMs });
    // Client-rendered, and sometimes inside an iframe: wait for the email field on the page or inside a Paddle frame.
    const root = await findRoot(page, loadMs);
    if (!root) {
      if (await captchaShown(page)) return { outcome: "captcha", submitted: false, detail: "bot check shown before the checkout form" };
      return { outcome: "unsupported_page", submitted: false, detail: "no Paddle checkout form found on the page" };
    }
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, detail: "bot check shown before the checkout form" };

    // Price check before anything is typed. Tax is not in yet, so only a total ABOVE the agreed amount is refused here.
    const first = await readTotal(root, page, Math.min(loadMs, 15_000));
    if (first.kind === "none") return { outcome: "unsupported_page", submitted: false, detail: "no readable total on the page" };
    if (first.kind === "foreign") return { outcome: "unsupported_page", submitted: false, detail: "the checkout total is not in US dollars" };
    if (first.cents > req.expectedAmountCents) return mismatch(first.cents, req.expectedAmountCents);

    // Country and postal code decide the tax. Both come from the card's billing details; without them, stop.
    const countryField = root.locator(SEL.country).first();
    const postalField = root.locator(SEL.postal).first();
    const wantsCountry = (await countryField.count()) > 0;
    const wantsPostal = (await postalField.count()) > 0;
    if ((wantsCountry && !addr?.country) || (wantsPostal && !c.billingZip)) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "the checkout needs a billing country and postal code and none is on file for this card" };
    }
    const email = root.locator(SEL.email).first();
    if (await isEditable(email)) await email.fill(req.email);
    if (wantsCountry) {
      const picked = await selectOne(countryField, addr!.country);
      // Never tax-and-ship to a country the card is not in.
      if (!picked) return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: `the checkout does not offer the card's billing country (${addr!.country})` };
      // Choosing a country re-renders the form and recalculates tax.
      await page.waitForTimeout(400);
    }
    if (wantsPostal) await root.locator(SEL.postal).first().fill(c.billingZip!);

    // Press continue until the card form is up (information -> payment).
    const number = () => root.locator(SEL.number).first();
    for (let step = 0; step < 2 && !(await number().isVisible().catch(() => false)); step++) {
      const next = root.getByRole("button", { name: /^continue\b/i }).filter({ visible: true }).first();
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click({ timeout: 5_000 });
      await number().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
    }
    if (!(await number().waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false))) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "card number field not found" };
    }
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, pageAmountCents: first.cents, detail: "bot check shown before the card form" };

    // Tax is known now. The amount the agent agreed to must be exactly the amount.
    const settled = await readTotal(root, page, 5_000);
    if (settled.kind !== "ok") return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "the total became unreadable after the billing step" };
    if (settled.cents !== req.expectedAmountCents) return mismatch(settled.cents, req.expectedAmountCents);

    // The card goes in only now.
    const typed = await typeCard(root, req);
    if (typed) return { outcome: "unsupported_page", submitted: false, pageAmountCents: settled.cents, detail: typed };

    const pay = root.getByRole("button", { name: /^(?:pay|subscribe|complete|buy)\b/i }).filter({ visible: true }).first();
    if (!(await payReady(pay, page, 15_000))) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents: settled.cents, detail: "the pay button never became ready; the page may want a field we do not have" };
    }
    const last = await readTotal(root, page, 2_000);
    if (last.kind !== "ok" || last.cents !== req.expectedAmountCents) {
      return { outcome: "amount_mismatch", submitted: false, pageAmountCents: last.kind === "ok" ? last.cents : settled.cents, detail: "the total changed while the form was being filled" };
    }
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, pageAmountCents: settled.cents, detail: "bot check shown before submit" };
    markSubmitted();
    await pay.click({ timeout: 10_000 });
    return this.watch(page, root, startUrl, settled.cents);
  }

  /** After pressing pay: a success state or redirect, a decline message, a challenge, or a timeout (unknown). */
  private async watch(page: Page, root: Root, startUrl: string, pageAmountCents: number): Promise<FillResult> {
    const deadline = Date.now() + (this.o.resultTimeoutMs ?? 60_000);
    const done = (outcome: FillResult["outcome"], detail: string): FillResult => ({ outcome, submitted: true, pageAmountCents, detail });
    const startPath = safePath(startUrl);
    while (Date.now() < deadline) {
      const url = page.url();
      const path = safePath(url);
      // Leaving the checkout for the merchant's success page, or Paddle's own success view. Only an explicit success
      // marker counts: a bare navigation elsewhere is not proof of payment.
      if (THANK_YOU.test(path) && path !== startPath) return done("succeeded", "redirected to a confirmation page");
      if ((await root.locator(SEL.success).first().isVisible().catch(() => false)) || SUCCESS_TEXT.test(await root.locator("body").innerText({ timeout: 1_000 }).catch(() => ""))) {
        return done("succeeded", "checkout shows its success state");
      }
      if (THREE_DS_URL.test(path) || hasFrame(page, THREE_DS_FRAME)) return done("three_ds", "3-D Secure challenge shown after submit");
      if (await captchaShown(page)) return done("captcha", "bot check shown after submit");
      const err = root.locator(SEL.error).first();
      if (await err.isVisible().catch(() => false)) {
        // Only the decline wording is matched; the message itself is not stored (it can echo field content).
        const text = (await err.innerText().catch(() => "")).toLowerCase();
        if (DECLINE_TEXT.test(text)) return done("declined", "page shows a card decline");
      }
      await page.waitForTimeout(500);
    }
    return done("error", "no result shown before the timeout; the charge state is unknown");
  }
}

/** The checkout surface: the page itself when it holds the form, else the Paddle iframe inside it. */
async function findRoot(page: Page, waitMs: number): Promise<Root | undefined> {
  const deadline = Date.now() + waitMs;
  const framed = page.frameLocator(SEL.frame).first();
  for (;;) {
    if (await page.locator(SEL.email).first().isVisible().catch(() => false)) return page;
    if ((await page.locator(SEL.frame).count()) > 0 && (await framed.locator(SEL.email).first().isVisible().catch(() => false))) return framed;
    if (Date.now() >= deadline) return undefined;
    await page.waitForTimeout(250);
  }
}

async function typeCard(root: Root, req: FillRequest): Promise<string | undefined> {
  const c = req.card;
  const type = async (sel: string, text: string) => {
    const input = root.locator(sel).first();
    if (!(await input.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false))) return false;
    await input.click();
    await input.pressSequentially(text, { delay: 15 });
    return true;
  };
  if (!(await type(SEL.number, digits(c.pan)))) return "card number field not found";
  if (!(await type(SEL.expiry, `${pad2(c.expMonth)}${String(c.expYear).slice(-2)}`))) return "expiry field not found";
  if (!(await type(SEL.cvv, digits(c.cvv)))) return "security code field not found";
  // The cardholder name is optional on some checkouts.
  if ((await root.locator(SEL.holder).count()) > 0) await type(SEL.holder, c.nameOnCard?.trim() || "Card Holder");
  return undefined;
}

type Total = { kind: "ok"; cents: number } | { kind: "foreign" } | { kind: "none" };

/** The total, polled: Paddle renders the summary after the form. A total in another currency is "foreign". */
async function readTotal(root: Root, page: Page, waitMs: number): Promise<Total> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const sel of SEL.totals) {
      const l = root.locator(sel).last();
      const text = (await l.count()) > 0 ? await l.innerText({ timeout: 2_000 }).catch(() => "") : "";
      if (!text) continue;
      // "EUR", "€10.00": anything but USD is refused rather than read as dollars.
      if (/\b(?!USD\b)[A-Z]{3}\b/.test(text) || /[€£¥₦₹]/.test(text)) return { kind: "foreign" };
      const cents = parseUsdCents(text);
      if (cents !== undefined) return { kind: "ok", cents };
    }
    if (Date.now() >= deadline) return { kind: "none" };
    await page.waitForTimeout(250);
  }
}

/** Pay is ready when it is visible, enabled, and not marked busy. */
async function payReady(pay: Locator, page: Page, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ok = (await pay.isVisible().catch(() => false)) && (await pay.isEnabled().catch(() => false)) && (await pay.getAttribute("aria-disabled").catch(() => null)) !== "true";
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
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
const selectOne = (l: Locator, v: string) => l.selectOption([{ value: v }, { label: v }], { timeout: 2_000 }).then((r) => r.length > 0, () => false);
