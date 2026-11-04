import type { PublicCheckoutView } from "../lib/interactors/CheckoutInteractor.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The page a "Pay with Agent Card" link opens. Server-rendered, no scripts: an agent reading it learns
 * what to call, and a person sees what is being bought.
 */
export function checkoutPage(c: PublicCheckoutView): string {
  const amount = `$${(c.amountCents / 100).toFixed(2)}`;
  const payable = c.status === "open";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="agent-cards-checkout" content="${esc(c.checkoutId)}">
<title>Pay ${esc(c.merchant)} ${amount}</title><link rel="stylesheet" href="/assets/site.css"></head>
<body><main style="max-width:32rem;margin:4rem auto;padding:0 1rem">
<p style="color:#666;margin:0">Agent Card checkout</p>
<h1 style="margin:.25rem 0 1rem">${esc(c.merchant)}</h1>
<p style="font-size:1.1rem">${esc(c.description)}</p>
<p style="font-size:2rem;font-weight:600;margin:.5rem 0">${amount} <span style="font-size:1rem;color:#666">${c.currency}</span></p>
<p>Status: <strong>${esc(c.status)}</strong>${payable ? ` · expires ${esc(c.expiresAt)}` : ""}</p>
${payable ? `<section style="border:1px solid #ddd;border-radius:12px;padding:1rem;margin-top:1.5rem">
<h2 style="margin-top:0;font-size:1rem">For AI agents</h2>
<p>Pay this with your Agent Card wallet. With the agent-cards MCP server, call <code>pay_checkout</code> with
<code>checkout_id</code> <code>${esc(c.checkoutId)}</code>. Over HTTP:</p>
<pre style="white-space:pre-wrap;word-break:break-all">POST /agent/v1/checkouts/${esc(c.checkoutId)}/pay
Authorization: Bearer ak_...
content-type: application/json

{}</pre>
<p>The price is set by the merchant. Paying again is safe: it returns the first result.</p>
</section>` : ""}
</main></body></html>`;
}
