import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for a Stripe Checkout hosted page, with Stripe's field ids, for tests and the rehearsal script.
 * No network, no real card processing. The scenario is in the path: /c/pay/<scenario>?amount=<cents>
 *
 *   success     pay redirects to the merchant's success URL (another host: localhost vs 127.0.0.1)
 *   complete    pay shows Stripe's "success" button state without redirecting
 *   decline     pay shows "Your card was declined."
 *   captcha     an hCaptcha frame is on the page from the start
 *   three_ds    pay opens a 3-D Secure challenge frame
 *   hang        pay does nothing (the result never comes); the button sits in Stripe's ready (--complete) state
 *   accordion   like success, but the card form sits behind Stripe's payment-method accordion
 *   nototal     no readable total
 *   address     like success, but the session collects a full billing address. As on real Stripe, the button is
 *               --clickable until every field is filled, then --complete (ready); a press before that does nothing
 *
 * Every page also carries a hidden 1px invisible-hCaptcha frame, as real Stripe Checkout does; it is not a bot check.
 *
 * The server only learns the last four digits of what was typed (to prove the card reached the form).
 */
export interface CheckoutFixture {
  /** e.g. http://127.0.0.1:53111 */
  base: string;
  url(scenario: string, amountCents: number): string;
  /** Submissions seen, newest last: scenario and the last four digits typed. */
  submissions: { scenario: string; last4: string }[];
  /** The onSubmit hook's last error message, if it threw. */
  readonly lastSubmitError: string | undefined;
  close(): Promise<void>;
}

/**
 * `onSubmit` runs when the page's pay button is pressed, before the page reacts; the sandbox end-to-end script uses it
 * to fire Miden's mock authorization, standing in for the card network. If it throws, the page shows a decline.
 */
export async function startCheckoutFixture(opts: { onSubmit?: (s: { scenario: string; last4: string; amountCents: number }) => Promise<void> } = {}): Promise<CheckoutFixture> {
  const submissions: CheckoutFixture["submissions"] = [];
  let lastSubmitError: string | undefined;
  let port = 0;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const b = JSON.parse(body || "{}") as { scenario?: string; last4?: string; amountCents?: number };
        const sub = { scenario: String(b.scenario), last4: String(b.last4).slice(-4) };
        submissions.push(sub);
        try {
          await opts.onSubmit?.({ ...sub, amountCents: Number(b.amountCents) });
          res.writeHead(204).end();
        } catch (e) {
          lastSubmitError = e instanceof Error ? e.message.slice(0, 200) : String(e);
          res.writeHead(402).end();
        }
      });
      return;
    }
    if (u.pathname === "/success") return html(res, "<h1>Thanks for your order</h1>");
    if (u.pathname.startsWith("/hcaptcha.com/") || u.pathname.startsWith("/three-d-secure/")) return html(res, "<p>challenge</p>");
    const m = /^\/c\/pay\/([a-z_]+)$/.exec(u.pathname);
    if (!m) return void res.writeHead(404).end();
    html(res, page(m[1]!, Number(u.searchParams.get("amount") ?? 1000), `http://localhost:${port}/success`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    url: (scenario, amountCents) => `${base}/c/pay/${scenario}?amount=${amountCents}`,
    submissions,
    get lastSubmitError() {
      return lastSubmitError;
    },
    // closeAllConnections: a browser's keep-alive sockets must not hold the process (and a test run) open.
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    }),
  };
}

function html(res: import("node:http").ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${body}</body></html>`);
}

function page(scenario: string, amountCents: number, successUrl: string): string {
  const total = scenario === "nototal" ? "" : `$${(amountCents / 100).toFixed(2)}`;
  const captcha = scenario === "captcha" ? `<iframe src="/hcaptcha.com/challenge" title="hcaptcha"></iframe>` : "";
  const hidden = scenario === "accordion" ? ` style="display:none"` : "";
  const accordion = scenario === "accordion"
    // As on real Stripe: a 0x0 button whose ::before covers the row, so only a click on the row reaches it.
    ? `<style>.acc{position:relative;height:40px}.acc button{position:static;width:0;height:0;padding:0;border:0;overflow:visible}.acc button::before{content:"";position:absolute;inset:0}</style>
<div class="acc" data-testid="card-accordion-item">Card<button type="button" aria-label="Pay with card" data-testid="card-accordion-item-button" onclick="document.getElementById('cardForm').style.display='block'"></button></div>` : "";
  return `
<h2>Pay Fixture Merchant</h2>
<div data-testid="product-summary-total-amount">${total}</div>
${captcha}
<iframe src="/hcaptcha.com/invisible" name="hcaptcha-invisible" style="visibility:hidden;width:1280px;height:1px;border:0"></iframe>
<input id="email" type="email">
${accordion}
<div id="cardForm"${hidden}>
  <fieldset id="cardNumber-fieldset"><input id="cardNumber"><div class="FieldError" id="err" style="display:none" role="alert"></div></fieldset>
  <input id="cardExpiry"><input id="cardCvc">
  <input id="billingName"><select id="billingCountry"><option value="NG">Nigeria</option><option value="US">United States</option></select>
  <input id="billingPostalCode">
  ${scenario === "address" ? `<input id="billingAddressLine1"><input id="billingAddressLine2"><input id="billingLocality">
  <select id="billingAdministrativeArea"><option value=""></option><option value="CA">California</option><option value="NY">New York</option></select>` : ""}
</div>
<button class="SubmitButton${scenario === "address" ? " SubmitButton--clickable" : scenario === "hang" ? " SubmitButton--complete" : ""}" data-testid="hosted-payment-submit-button" id="pay">Pay</button>
<script>
const scenario = ${JSON.stringify(scenario)};
const amountCents = ${JSON.stringify(amountCents)};
const missing = () => ["billingAddressLine1", "billingLocality", "billingAdministrativeArea", "billingPostalCode"].filter((id) => { const e = document.getElementById(id); return e && !e.value; });
if (scenario === "address") document.addEventListener("input", () => {
  const b = document.getElementById("pay");
  b.classList.toggle("SubmitButton--complete", !missing().length);
  b.classList.toggle("SubmitButton--clickable", !!missing().length);
});
document.getElementById("pay").addEventListener("click", async () => {
  // Like Stripe: until the form is complete a press does nothing; nothing is sent.
  if (scenario === "address" && missing().length) { for (const id of missing()) document.getElementById(id).setAttribute("aria-invalid", "true"); return; }
  const last4 = document.getElementById("cardNumber").value.replace(/\\D/g, "").slice(-4);
  const r = await fetch("/submit", { method: "POST", body: JSON.stringify({ scenario, last4, amountCents }) });
  if (r.status === 402) { const e = document.getElementById("err"); e.textContent = "Your card was declined."; e.style.display = "block"; }
  else if (scenario === "success" || scenario === "accordion" || scenario === "address") location.href = ${JSON.stringify(successUrl)};
  else if (scenario === "complete") document.getElementById("pay").classList.add("SubmitButton--success");
  else if (scenario === "decline") { const e = document.getElementById("err"); e.textContent = "Your card was declined."; e.style.display = "block"; }
  else if (scenario === "three_ds") { const f = document.createElement("iframe"); f.src = "/three-d-secure/challenge"; document.body.appendChild(f); }
});
</script>`;
}
