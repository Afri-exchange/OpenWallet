import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for a Paddle Billing checkout, for tests. No network, no Paddle account, no real card processing.
 * It mirrors what the PaddleFiller relies on: email, country and postal code first, a "Continue" press, then card
 * number, expiry, security code and cardholder name, tax added to the total once country and postal code are in, and
 * a "Pay" button. It proves our logic, not that Paddle's real markup still looks like this.
 *
 * Scenario and amount are in the path: /hsc/<scenario>?amount=<cents> is a hosted checkout (the page is the checkout);
 * /shop/<scenario>?_ptxn=txn_1&amount=<cents> is a merchant page that holds the checkout in a cross-origin iframe.
 *
 *   success     total is the amount, tax included; pay shows "Payment successful"
 *   redirect    like success, but pay navigates to a /done page
 *   tax         total at load is the amount; after country + postal code it is amount + $0.80
 *   foreign     total shown in euros
 *   decline     pay shows a decline
 *   captcha     a visible bot check from the start
 *   three_ds    pay opens a 3-D Secure frame
 *   hang        pay does nothing
 *   nototal     no readable total
 *
 * The server only learns the last four digits typed (to prove the card reached the form) and the billing fields.
 */
export interface PaddleFixture {
  base: string;
  hosted(scenario: string, amountCents: number): string;
  embedded(scenario: string, amountCents: number): string;
  submissions: { scenario: string; last4: string; fields: Record<string, string> }[];
  close(): Promise<void>;
}

export async function startPaddleFixture(): Promise<PaddleFixture> {
  const submissions: PaddleFixture["submissions"] = [];
  let port = 0;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body || "{}") as { scenario?: string; last4?: string; fields?: Record<string, string> };
        submissions.push({ scenario: String(b.scenario), last4: String(b.last4).slice(-4), fields: b.fields ?? {} });
        res.writeHead(204).end();
      });
      return;
    }
    if (u.pathname.startsWith("/hcaptcha.com/") || u.pathname.startsWith("/three-d-secure/")) return html(res, "<p>challenge</p>");
    if (/^\/done$/.test(u.pathname)) return html(res, "<h1>Thanks</h1>");
    const amount = Number(u.searchParams.get("amount") ?? 1000);
    const hosted = /^\/hsc\/([a-z_]+)$/.exec(u.pathname);
    if (hosted) return html(res, checkout(hosted[1]!, amount));
    const frame = /^\/frame\/([a-z_]+)$/.exec(u.pathname);
    if (frame) return html(res, checkout(frame[1]!, amount));
    const shop = /^\/shop\/([a-z_]+)$/.exec(u.pathname);
    if (shop) return html(res, `<h1>Acme</h1><iframe name="paddle_frame" class="paddle-frame-inline" src="http://localhost:${port}/frame/${shop[1]}?amount=${amount}" style="width:420px;height:720px;border:0"></iframe>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    hosted: (scenario, amountCents) => `${base}/hsc/${scenario}?amount=${amountCents}`,
    embedded: (scenario, amountCents) => `${base}/shop/${scenario}?_ptxn=txn_01&amount=${amountCents}`,
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

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function checkout(scenario: string, amountCents: number): string {
  const shown = scenario === "nototal" ? "" : scenario === "foreign" ? "€10.00" : money(amountCents);
  const captcha = scenario === "captcha" ? `<iframe src="/hcaptcha.com/challenge" title="hcaptcha"></iframe>` : "";
  return `
${captcha}
<div data-testid="total-due-today" id="total">${shown}</div>
<div id="info">
  <input name="email" type="email" aria-label="Email address">
  <select name="country"><option value="NG">Nigeria</option><option value="US">United States</option></select>
  <input name="postalCode" aria-label="ZIP code">
  <button type="button" id="continue">Continue</button>
</div>
<div id="payment" style="display:none">
  <input name="cardNumber" aria-label="Card number" autocomplete="cc-number">
  <input name="expiry" aria-label="Expiration date" autocomplete="cc-exp">
  <input name="cvv" aria-label="Security code" autocomplete="cc-csc">
  <input name="cardholderName" aria-label="Cardholder name" autocomplete="cc-name">
  <p id="err" role="alert" style="display:none"></p>
  <button type="button" id="pay">Pay</button>
</div>
<div data-testid="success" id="ok" style="display:none">Payment successful</div>
<script>
const scenario = ${JSON.stringify(scenario)};
const $ = (s) => document.querySelector(s);
$("#continue").addEventListener("click", () => {
  if (!$('[name="email"]').value || !$('[name="postalCode"]').value) return;
  if (scenario === "tax") $("#total").textContent = ${JSON.stringify(money(amountCents + 80))};
  $("#info").style.display = "none"; $("#payment").style.display = "block";
});
const showErr = (t) => { const e = $("#err"); e.textContent = t; e.style.display = "block"; };
$("#pay").addEventListener("click", async () => {
  const num = $('[name="cardNumber"]').value, exp = $('[name="expiry"]').value, cvv = $('[name="cvv"]').value;
  if (!num || !exp || !cvv) return showErr("Enter a valid card number");
  const fields = { email: $('[name="email"]').value, country: $('[name="country"]').value, postal: $('[name="postalCode"]').value, expiry: exp, cvvLength: String(cvv.length), name: $('[name="cardholderName"]').value };
  await fetch("/submit", { method: "POST", body: JSON.stringify({ scenario, last4: num.replace(/\\D/g, "").slice(-4), fields }) }).catch(() => {});
  if (scenario === "hang") return;
  if (scenario === "decline") return showErr("Your payment was declined.");
  if (scenario === "three_ds") { const f = document.createElement("iframe"); f.src = "/three-d-secure/challenge"; document.body.appendChild(f); return; }
  if (scenario === "redirect") { location.href = "/done"; return; }
  $("#payment").style.display = "none"; $("#ok").style.display = "block";
});
</script>`;
}
