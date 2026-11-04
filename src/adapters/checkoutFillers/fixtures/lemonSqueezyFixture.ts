import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for a Lemon Squeezy checkout, for tests. No network, no Lemon Squeezy account, no real card
 * processing. It mirrors the structure the LemonSqueezyFiller relies on: email / name / country / zip fields, a total
 * element, tax that appears once a country and ZIP are entered (Lemon Squeezy is the merchant of record), and the card
 * in CROSS-ORIGIN iframes (served from localhost while the page is on 127.0.0.1, as Stripe serves its frames).
 * It proves our logic, not that Lemon Squeezy's real markup looks like this.
 * Scenario is in the path: /checkout/buy/<scenario>?amount=<cents>
 *
 *   success     card in three separate frames, no tax
 *   combined    card number + expiry + cvc in ONE frame (Payment Element layout)
 *   tax         $1.00 tax is added once country and ZIP are filled
 *   foreign     total shown in EUR
 *   decline     pay shows a decline
 *   captcha     a visible bot check from the start
 *   three_ds    pay opens a 3-D Secure frame
 *   hang        pay does nothing
 *   nototal     no readable total
 *
 * The server only learns the last four digits typed (to prove the card reached the form).
 */
export interface LemonSqueezyFixture {
  base: string;
  url(scenario: string, amountCents: number): string;
  submissions: { scenario: string; last4: string; fields: Record<string, string> }[];
  close(): Promise<void>;
}

export async function startLemonSqueezyFixture(): Promise<LemonSqueezyFixture> {
  const submissions: LemonSqueezyFixture["submissions"] = [];
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
    const pci = /^\/stripe\/([a-z]+)$/.exec(u.pathname);
    if (pci) return html(res, stripeFrame(pci[1]!));
    if (/\/confirmation$/.test(u.pathname)) return html(res, "<h1>Thank you for your order</h1>");
    const m = /^\/checkout\/buy\/([a-z_]+)$/.exec(u.pathname);
    if (!m) return void res.writeHead(404).end();
    html(res, page(m[1]!, Number(u.searchParams.get("amount") ?? 1000), `http://localhost:${port}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    url: (scenario, amountCents) => `${base}/checkout/buy/${scenario}?amount=${amountCents}`,
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

/** One Stripe-like iframe document. "all" holds the three inputs; the others hold one each. Inputs report to the parent. */
function stripeFrame(kind: string): string {
  const inputs: Record<string, string> = {
    number: `<input name="cardnumber" autocomplete="off">`,
    expiry: `<input name="exp-date" autocomplete="off">`,
    cvc: `<input name="cvc" autocomplete="off">`,
  };
  const body = kind === "all" ? `${inputs.number}${inputs.expiry}${inputs.cvc}` : inputs[kind] ?? "";
  return `${body}<script>
for (const i of document.querySelectorAll("input")) i.addEventListener("input", () => parent.postMessage({ field: i.name, value: i.value }, "*"));
</script>`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function page(scenario: string, amountCents: number, stripeOrigin: string): string {
  const shown = scenario === "nototal" ? "" : scenario === "foreign" ? "€10.00 EUR" : `${money(amountCents)} USD`;
  const frame = (kind: string) => `<iframe name="__privateStripeFrame_${kind}" title="Secure card input" src="${stripeOrigin}/stripe/${kind}" style="width:300px;height:40px;border:0"></iframe>`;
  const cardFrames = scenario === "combined" ? frame("all") : `${frame("number")}${frame("expiry")}${frame("cvc")}`;
  const captcha = scenario === "captcha" ? `<iframe src="/hcaptcha.com/challenge" title="hcaptcha"></iframe>` : "";
  return `
<section aria-label="Order summary"><span>Total</span> <strong id="total" data-testid="order-total">${shown}</strong></section>
${captcha}
<form id="f" onsubmit="return false">
  <input name="email" id="email" type="email">
  <input name="name">
  <select name="country"><option value="NG">Nigeria</option><option value="US">United States</option></select>
  <input name="zip">
  ${cardFrames}
  <p id="err" role="alert" style="display:none"></p>
  <button type="submit" id="pay">Pay</button>
</form>
<script>
const scenario = ${JSON.stringify(scenario)};
const amountCents = ${JSON.stringify(amountCents)};
const card = {};
addEventListener("message", (e) => { if (e.data && e.data.field) card[e.data.field] = e.data.value; });
const $ = (s) => document.querySelector(s);
if (scenario === "tax") {
  const update = () => { if ($('[name="zip"]').value) $("#total").textContent = ${JSON.stringify(money(amountCents + 100) + " USD")}; };
  $('[name="zip"]').addEventListener("input", update);
}
const showErr = (t) => { const e = $("#err"); e.textContent = t; e.style.display = "block"; };
$("#pay").addEventListener("click", async () => {
  if (!card.cardnumber || !card["exp-date"] || !card.cvc) return showErr("Your card number is incomplete.");
  const fields = { email: $("#email").value, name: $('[name="name"]').value, country: $('[name="country"]').value, zip: $('[name="zip"]').value, expiry: card["exp-date"], cvcLength: String(card.cvc.length) };
  await fetch("/submit", { method: "POST", body: JSON.stringify({ scenario, last4: card.cardnumber.replace(/\\D/g, "").slice(-4), fields }) });
  if (scenario === "hang") return;
  if (scenario === "decline") showErr("Your card was declined.");
  else if (scenario === "three_ds") { const f = document.createElement("iframe"); f.src = "/three-d-secure/challenge"; document.body.appendChild(f); }
  else location.href = "/checkout/buy/" + scenario + "/confirmation";
});
</script>`;
}
