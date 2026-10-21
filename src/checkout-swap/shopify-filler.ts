import type { Browser, Locator, Page } from "playwright-core";
import { parseUsdCents, type CheckoutFiller, type FillRequest, type FillResult } from "./filler.js";
import { THREE_DS_FRAME, captchaShown, cardFree, digits, hasFrame, isEditable, pad2, usd } from "./playwright-filler.js";

/**
 * Fills a Shopify checkout (https://<shop>.myshopify.com/checkouts/cn/<token>, or the same path on a shop's own domain)
 * in headless Chromium. Same contract as the Stripe filler: check the price first, type the card as late as possible,
 * report an outcome without page content.
 *
 * What differs from Stripe:
 *  - Card number, expiry, security code and name each live in their own cross-origin iframe, so they are reached with
 *    frame locators and typed key by key (the fields are masked inputs).
 *  - There is a contact + address section before the card. Shipping adds to the total, so the price is checked at load
 *    AND again once the information steps are done, right before the card is typed.
 *  - Older checkouts spread this over several pages (information -> shipping -> payment); one-page checkouts show it all.
 *    Both are handled by pressing "continue" until the card fields exist.
 *
 * The selectors come from Shopify's published checkout markup as we know it, NOT from a live shop (see
 * docs/checkout-swap.md, "Shopify"). shopify-fixture.ts mirrors them, so tests prove the logic, not the selectors.
 */

export interface ShopifyFillerOptions {
  headless?: boolean;
  loadTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** For tests: an already launched browser (not closed by the filler). */
  browser?: Browser;
}

const SEL = {
  /** Tried in order; the first one that holds a readable amount wins. */
  totals: [
    "[data-checkout-payment-due-target]",
    ".total-line--total .total-line__price",
    '[role="row"]:has([role="rowheader"]:text-is("Total")) [role="cell"]',
  ],
  email: 'input[name="email"], input#email',
  country: 'select[name="countryCode"]',
  firstName: 'input[name="firstName"]',
  lastName: 'input[name="lastName"]',
  address1: 'input[name="address1"]',
  address2: 'input[name="address2"]',
  city: 'input[name="city"]',
  zone: 'select[name="zone"], input[name="zone"]',
  postal: 'input[name="postalCode"]',
  /** Card fields: one iframe each, one input inside each. */
  numberFrame: 'iframe[title*="Card number" i]',
  expiryFrame: 'iframe[title*="Expiration" i]',
  cvvFrame: 'iframe[title*="Security code" i]',
  nameFrame: 'iframe[title*="Name on card" i]',
  /** "Continue to shipping" / "Continue to payment" on multi-page checkouts. */
  next: "#continue_button, button:has-text('Continue to shipping'), button:has-text('Continue to payment')",
  pay: "#checkout-pay-button, button[type='submit']:has-text('Pay now')",
  error: '[role="alert"], .notice--error, [id^="error-for-"]',
};
const THANK_YOU = /\/thank[-_]?you(?:[/?#]|$)|\/orders\/[A-Za-z0-9]+/i;
const THREE_DS_URL = /\/authentications\/|\/three_d_secure|\/3d_secure|3ds/i;

export class ShopifyFiller implements CheckoutFiller {
  constructor(private readonly o: ShopifyFillerOptions = {}) {}

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
    const numberFrame = page.locator(SEL.numberFrame).first();

    await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: loadMs });
    // Client-rendered: wait for the contact form or the card fields, whichever the checkout shows first.
    await Promise.race([
      page.locator(SEL.email).first().waitFor({ state: "visible", timeout: loadMs }),
      numberFrame.waitFor({ state: "attached", timeout: loadMs }),
    ]).catch(() => undefined);
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, detail: "bot check shown before the checkout form" };

    // Price check before anything is typed.
    const first = await readTotal(page, Math.min(loadMs, 15_000));
    if (first.kind === "none") return { outcome: "unsupported_page", submitted: false, detail: "no readable total on the page" };
    if (first.kind === "foreign") return { outcome: "unsupported_page", submitted: false, detail: "the checkout total is not in US dollars" };
    if (first.cents !== req.expectedAmountCents) return mismatch(first.cents, req.expectedAmountCents);

    // Contact + delivery. Only fields the checkout actually shows are filled; shipping needs an address on file.
    const email = page.locator(SEL.email).first();
    if (await isEditable(email)) await email.fill(req.email);
    const needsAddress = await page.locator(SEL.address1).first().isVisible().catch(() => false);
    if (needsAddress) {
      if (!addr?.line1 || !addr.city || !c.billingZip) {
        return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "the checkout asks for a delivery or billing address and none is on file for this card" };
      }
      const country = page.locator(SEL.country).first();
      if ((await country.count()) > 0) {
        const picked = await selectOne(country, addr.country || "US");
        // Never type one country's address into another country's form.
        if (!picked) return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: `the checkout does not offer the card's billing country (${addr.country})` };
        // Choosing a country re-renders the address block.
        await page.waitForTimeout(400);
      }
      const [given, ...rest] = (c.nameOnCard?.trim() || "Card Holder").split(/\s+/);
      await fillIf(page.locator(SEL.firstName).first(), given ?? "Card");
      await fillIf(page.locator(SEL.lastName).first(), rest.join(" ") || "Holder");
      await fillIf(page.locator(SEL.address1).first(), addr.line1);
      if (addr.line2) await fillIf(page.locator(SEL.address2).first(), addr.line2);
      await fillIf(page.locator(SEL.city).first(), addr.city);
      const zone = page.locator(SEL.zone).first();
      if (addr.state && (await zone.isVisible().catch(() => false))) {
        const isSelect = await zone.evaluate((el) => el.tagName === "SELECT").catch(() => false);
        const ok = isSelect ? await selectOne(zone, addr.state) : await zone.fill(addr.state).then(() => true, () => false);
        if (!ok) return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: `the checkout has no state option matching "${addr.state}"` };
      }
      await fillIf(page.locator(SEL.postal).first(), c.billingZip);
    }

    // Multi-page checkouts: press continue until the card fields appear (information -> shipping -> payment).
    for (let step = 0; step < 3 && !(await numberFrame.isVisible().catch(() => false)); step++) {
      const next = page.locator(SEL.next).filter({ visible: true }).first();
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click({ timeout: 5_000 });
      await Promise.race([numberFrame.waitFor({ state: "visible", timeout: 8_000 }), page.waitForLoadState("domcontentloaded", { timeout: 8_000 })]).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    if (!(await numberFrame.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false))) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "card number field not found" };
    }
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, pageAmountCents: first.cents, detail: "bot check shown before the card form" };

    // Shipping and tax are known now. The price the agent agreed to must still be the price.
    const settled = await readTotal(page, 5_000);
    if (settled.kind !== "ok") return { outcome: "unsupported_page", submitted: false, pageAmountCents: first.cents, detail: "the total became unreadable after the delivery step" };
    if (settled.cents !== req.expectedAmountCents) return mismatch(settled.cents, req.expectedAmountCents);

    // The card goes in only now.
    const typed = await this.typeCard(page, req);
    if (typed) return { outcome: "unsupported_page", submitted: false, pageAmountCents: settled.cents, detail: typed };

    const pay = page.locator(SEL.pay).first();
    if (!(await payReady(pay, 15_000))) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents: settled.cents, detail: "the pay button never became ready; the page may want a field we do not have" };
    }
    // Last look at the price: a fixed-selector read, no card content involved.
    const last = await readTotal(page, 2_000);
    if (last.kind !== "ok" || last.cents !== req.expectedAmountCents) {
      return { outcome: "amount_mismatch", submitted: false, pageAmountCents: last.kind === "ok" ? last.cents : settled.cents, detail: "the total changed while the form was being filled" };
    }
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, pageAmountCents: settled.cents, detail: "bot check shown before submit" };
    markSubmitted();
    await pay.click({ timeout: 10_000 });
    return this.watch(page, settled.cents);
  }

  /** Types the card into Shopify's field iframes. Returns a reason when a field is missing, else undefined. */
  private async typeCard(page: Page, req: FillRequest): Promise<string | undefined> {
    const c = req.card;
    const type = async (frameSel: string, text: string) => {
      const input = page.frameLocator(frameSel).first().locator("input").first();
      if (!(await input.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false))) return false;
      await input.click();
      await input.pressSequentially(text, { delay: 15 });
      return true;
    };
    if (!(await type(SEL.numberFrame, digits(c.pan)))) return "card number field not found";
    if (!(await type(SEL.expiryFrame, `${pad2(c.expMonth)}${String(c.expYear).slice(-2)}`))) return "expiry field not found";
    if (!(await type(SEL.cvvFrame, digits(c.cvv)))) return "security code field not found";
    // The name field is optional on some checkouts.
    if (await page.locator(SEL.nameFrame).first().count()) await type(SEL.nameFrame, c.nameOnCard?.trim() || "Card Holder");
    return undefined;
  }

  /** After pressing pay: thank-you page, a decline message, a challenge, or a timeout (unknown). */
  private async watch(page: Page, pageAmountCents: number): Promise<FillResult> {
    const deadline = Date.now() + (this.o.resultTimeoutMs ?? 60_000);
    const done = (outcome: FillResult["outcome"], detail: string): FillResult => ({ outcome, submitted: true, pageAmountCents, detail });
    while (Date.now() < deadline) {
      const url = page.url();
      if (THANK_YOU.test(safePath(url))) return done("succeeded", "redirected to the order confirmation page");
      if (THREE_DS_URL.test(safePath(url)) || hasFrame(page, THREE_DS_FRAME)) return done("three_ds", "3-D Secure challenge shown after submit");
      if (await captchaShown(page)) return done("captcha", "bot check shown after submit");
      const err = page.locator(SEL.error).first();
      if (await err.isVisible().catch(() => false)) {
        // Only the decline wording is matched; the message itself is not stored (it can echo field content).
        const text = (await err.innerText().catch(() => "")).toLowerCase();
        if (/declin|insufficient|do not honou?r|not supported|incorrect|invalid|could not be processed|failure/.test(text)) return done("declined", "page shows a card decline");
      }
      await page.waitForTimeout(500);
    }
    return done("error", "no result shown before the timeout; the charge state is unknown");
  }
}

type Total = { kind: "ok"; cents: number } | { kind: "foreign" } | { kind: "none" };

/** The order total, polled: Shopify renders the summary after the form. A total in another currency is "foreign". */
async function readTotal(page: Page, waitMs: number): Promise<Total> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const sel of SEL.totals) {
      const l = page.locator(sel).last();
      const text = (await l.count()) > 0 ? await l.innerText({ timeout: 2_000 }).catch(() => "") : "";
      if (!text) continue;
      // "CAD", "EUR", "€10.00": anything but USD is refused rather than read as dollars.
      if (/\b(?!USD\b)[A-Z]{3}\b/.test(text) || /[€£¥₦₹]/.test(text)) return { kind: "foreign" };
      const cents = parseUsdCents(text);
      if (cents !== undefined) return { kind: "ok", cents };
    }
    if (Date.now() >= deadline) return { kind: "none" };
    await page.waitForTimeout(250);
  }
}

/** Pay is ready when it is visible, enabled, and not marked busy. */
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
async function fillIf(l: Locator, v: string): Promise<void> {
  if (await isEditable(l)) await l.fill(v);
}
/** A select matches on value or on label ("NG" or "Nigeria"). */
const selectOne = (l: Locator, v: string) => l.selectOption([{ value: v }, { label: v }]).then((r) => r.length > 0, () => false);
