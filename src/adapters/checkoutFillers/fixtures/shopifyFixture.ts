import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for a Shopify checkout, for tests and the rehearsal script. No network, no Shopify account, no
 * real card processing. It mirrors the structure the ShopifyFiller relies on: contact and address fields named
 * email / countryCode / firstName / ... / postalCode, a total row, and card number, expiry, security code and name
 * each in their own CROSS-ORIGIN iframe (served from localhost while the page is on 127.0.0.1, as Shopify serves
 * them from its PCI host), talking to the page by postMessage. It proves our logic, not that Shopify's real markup
 * still looks like this. Scenario is in the path: /checkouts/cn/<scenario>?amount=<cents>
 *
 *   success     digital goods: email + card, pay goes to the thank-you page
 *   shipping    physical goods: also an address block that must be filled (the pay press is ignored until it is)
 *   multistep   information -> shipping -> payment over "continue" presses; same total all the way
 *   pricechange like multistep, but the shipping step adds $5.00 to the total
 *   rowtotal    success, with the total in a role="row" instead of the classic price element
 *   foreign     total shown as CA$ ... CAD
 *   decline     pay shows a decline
 *   bogus       Shopify's Bogus Gateway rules: card number 1 succeeds, 2 declines, 3 raises an exception (silent), others decline
 *   captcha     a visible bot check from the start
 *   three_ds    pay opens a 3-D Secure frame
 *   hang        pay does nothing
 *   nototal     no readable total
 *
 * The server only learns the last digit(s) typed (to prove the card reached the form): last four, or the whole value if shorter.
 */
export interface ShopifyFixture {
  base: string;
  url(scenario: string, amountCents: number): string;
  submissions: { scenario: string; last4: string; fields: Record<string, string> }[];
  close(): Promise<void>;
}

export async function startShopifyFixture(opts: { onSubmit?: (s: { scenario: string; last4: string; amountCents: number }) => Promise<void> } = {}): Promise<ShopifyFixture> {
  const submissions: ShopifyFixture["submissions"] = [];
  let port = 0;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const b = JSON.parse(body || "{}") as { scenario?: string; last4?: string; amountCents?: number; fields?: Record<string, string> };
        const sub = { scenario: String(b.scenario), last4: String(b.last4).slice(-4), fields: b.fields ?? {} };
        submissions.push(sub);
        if (sub.scenario === "bogus") return void res.writeHead(sub.last4 === "1" ? 204 : sub.last4 === "3" ? 500 : 402).end();
        try {
          await opts.onSubmit?.({ scenario: sub.scenario, last4: sub.last4, amountCents: Number(b.amountCents) });
          res.writeHead(204).end();
        } catch {
          res.writeHead(402).end();
        }
      });
      return;
    }
    if (u.pathname.startsWith("/hcaptcha.com/") || u.pathname.startsWith("/three-d-secure/")) return html(res, "<p>challenge</p>");
    const pci = /^\/pci\/([a-z_]+)$/.exec(u.pathname);
    if (pci) return html(res, cardField(pci[1]!));
    if (/\/thank-you$/.test(u.pathname)) return html(res, "<h1>Thank you!</h1>");
    const m = /^\/checkouts\/cn\/([a-z_]+)$/.exec(u.pathname);
    if (!m) return void res.writeHead(404).end();
    html(res, page(m[1]!, Number(u.searchParams.get("amount") ?? 1000), `http://localhost:${port}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    url: (scenario, amountCents) => `${base}/checkouts/cn/${scenario}?amount=${amountCents}`,
    submissions,
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    }),
  };
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${body}</body></html>`);
}

/** One card field's iframe document: a masked-looking input that reports to the parent page. */
function cardField(field: string): string {
  return `<input name="${field}" autocomplete="off"><script>
document.querySelector("input").addEventListener("input", (e) => parent.postMessage({ field: ${JSON.stringify(field)}, value: e.target.value }, "*"));
</script>`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function page(scenario: string, amountCents: number, pciOrigin: string): string {
  const physical = ["shipping", "multistep", "pricechange"].includes(scenario);
  const steps = scenario === "multistep" || scenario === "pricechange";
  const shown = scenario === "nototal" ? "" : scenario === "foreign" ? "CA$10.00 CAD" : `${money(amountCents)} USD`;
  const total = scenario === "rowtotal"
    ? `<div role="row"><div role="rowheader">Total</div><div role="cell"><strong id="total">${shown}</strong></div></div>`
    : `<div class="total-line total-line--total"><span>Total</span><strong id="total" class="total-line__price" data-checkout-payment-due-target="${amountCents}">${shown}</strong></div>`;
  const frame = (field: string, title: string) => `<iframe title="Field container for: ${title}" src="${pciOrigin}/pci/${field}" style="width:300px;height:40px;border:0"></iframe>`;
  const captcha = scenario === "captcha" ? `<iframe src="/hcaptcha.com/challenge" title="hcaptcha"></iframe>` : "";
  return `
<section aria-label="Order summary">${total}</section>
${captcha}
<div id="info">
  <input name="email" id="email" type="email">
  ${physical || scenario === "shipping" ? `<select name="countryCode"><option value="NG">Nigeria</option><option value="US">United States</option></select>
  <input name="firstName"><input name="lastName"><input name="address1"><input name="address2"><input name="city">
  <select name="zone"><option value=""></option><option value="CA">California</option><option value="NY">New York</option></select>
  <input name="postalCode">` : ""}
  ${steps ? `<button type="button" id="continue_button">Continue to shipping</button>` : ""}
</div>
<div id="shipping" style="display:none"><p>Standard shipping</p><button type="button" id="continue_button2">Continue to payment</button></div>
<div id="payment"${steps ? ` style="display:none"` : ""}>
  ${frame("number", "Card number")}${frame("expiry", "Expiration date (MM / YY)")}${frame("verification_value", "Security code")}${frame("name", "Name on card")}
  <p id="err" role="alert" style="display:none"></p>
  <button type="submit" id="checkout-pay-button"><span>Pay now</span></button>
</div>
<script>
const scenario = ${JSON.stringify(scenario)};
const amountCents = ${JSON.stringify(amountCents)};
const card = {};
addEventListener("message", (e) => { if (e.data && e.data.field) card[e.data.field] = e.data.value; });
const $ = (s) => document.querySelector(s);
const addressMissing = () => ${physical ? `["address1", "city", "zone", "postalCode"].filter((n) => !$('[name="' + n + '"]').value)` : "[]"};
if (${steps}) {
  $("#continue_button").addEventListener("click", () => {
    if (addressMissing().length) return;
    $("#info").style.display = "none"; $("#shipping").style.display = "block";
  });
  $("#continue_button2").addEventListener("click", () => {
    if (scenario === "pricechange") { $("#total").textContent = ${JSON.stringify(money(amountCents + 500) + " USD")}; $("#total").setAttribute("data-checkout-payment-due-target", ${amountCents + 500}); }
    $("#shipping").style.display = "none"; $("#payment").style.display = "block";
  });
}
const showErr = (t) => { const e = $("#err"); e.textContent = t; e.style.display = "block"; };
$("#checkout-pay-button").addEventListener("click", async () => {
  if (!card.number || !card.expiry || !card.verification_value) return showErr("Enter a valid card number");
  if (scenario === "shipping" && addressMissing().length) return showErr("Enter an address");
  const fields = { email: $("#email").value, name: card.name || "", expiry: card.expiry, cvvLength: String((card.verification_value || "").length), address1: ${physical ? `$('[name="address1"]').value` : `""`}, country: ${physical ? `$('[name="countryCode"]').value` : `""`} };
  const last4 = card.number.replace(/\\D/g, "").slice(-4);
  const r = await fetch("/submit", { method: "POST", body: JSON.stringify({ scenario, last4, amountCents, fields }) });
  if (scenario === "hang") return;
  if (r.status === 402) showErr("Your payment was declined.");
  else if (r.status === 500) showErr("Something went wrong. Please try again.");
  else if (scenario === "decline") showErr("Your payment was declined.");
  else if (scenario === "three_ds") { const f = document.createElement("iframe"); f.src = "/three-d-secure/challenge"; document.body.appendChild(f); }
  else location.href = "/checkouts/cn/" + scenario + "/thank-you";
});
</script>`;
}
