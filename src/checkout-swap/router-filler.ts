import type { CheckoutFiller, FillRequest, FillResult } from "./filler.js";
import { PlaywrightFiller } from "./playwright-filler.js";
import { ShopifyFiller } from "./shopify-filler.js";

/**
 * Picks the filler that knows the page: Stripe Checkout (stripe.com hosts, /c/pay/ links) or a Shopify checkout
 * (/checkouts/... on a myshopify.com host or a shop's own domain). Anything else is refused before a browser opens.
 * Which hosts may be paid at all is the swap's allowlist (SWAP_ALLOWED_HOSTS), not this.
 */
export class RoutingFiller implements CheckoutFiller {
  constructor(private readonly fillers: { stripe: CheckoutFiller; shopify: CheckoutFiller } = { stripe: new PlaywrightFiller(), shopify: new ShopifyFiller() }) {}

  fill(req: FillRequest): Promise<FillResult> {
    const kind = checkoutKind(req.url);
    if (kind === "stripe") return this.fillers.stripe.fill(req);
    if (kind === "shopify") return this.fillers.shopify.fill(req);
    return Promise.resolve({ outcome: "unsupported_page", submitted: false, detail: "no filler for this kind of checkout page" });
  }
}

export function checkoutKind(url: string): "stripe" | "shopify" | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.host === "stripe.com" || u.host.endsWith(".stripe.com") || /^\/c\/pay\//.test(u.pathname)) return "stripe";
  if (/^\/(?:\d+\/)?checkouts\//.test(u.pathname)) return "shopify";
  return undefined;
}
