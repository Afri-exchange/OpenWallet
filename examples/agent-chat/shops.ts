import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Two demo merchants that are NOT Stripe, served by the chat server, so the agent can be seen paying checkout forms
 * Agent Cards has no filler for:
 *   kola    Kola Coffee: a plain form whose fields carry standard autocomplete labels (cc-number, cc-exp...). Agent Cards
 *           recognises it from the labels, no model involved.
 *   ankara  Ankara Prints: odd wording ("Long number on the front", "Good thru"), split expiry, a terms box and a
 *           newsletter box. Agent Cards asks a model to map it (the model never sees the card).
 * Only Stripe's public test card numbers are accepted; nothing is charged anywhere. The server keeps the last four
 * digits of what was typed and nothing else.
 */

export type ShopId = "kola" | "ankara";
export const SHOPS: Record<ShopId, { name: string; products: { id: string; name: string; priceCents: number }[] }> = {
  kola: {
    name: "Kola Coffee",
    products: [
      { id: "house-blend", name: "House blend, 250 g", priceCents: 400 },
      { id: "cold-brew", name: "Cold brew pack", priceCents: 300 },
    ],
  },
  ankara: {
    name: "Ankara Prints",
    products: [
      { id: "print-a4", name: "Ankara pattern print, A4", priceCents: 250 },
      { id: "tote", name: "Ankara tote bag", priceCents: 600 },
    ],
  },
};

interface Order { id: string; shop: ShopId; item: string; amountCents: number; status: "open" | "paid" | "declined"; last4?: string; paidAt?: string }
const orders = new Map<string, Order>();
const TEST_CARDS = new Set(["4242424242424242", "4000056655665556", "5555555555554444", "2223003122003222", "378282246310005"]);

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createShopOrder(base: string, shop: ShopId, productId: string, quantity: number) {
  const p = SHOPS[shop].products.find((x) => x.id === productId);
  if (!p) throw new Error(`unknown product for ${SHOPS[shop].name}`);
  const id = `o_${randomBytes(6).toString("hex")}`;
  const order: Order = { id, shop, item: `${quantity} x ${p.name}`, amountCents: p.priceCents * quantity, status: "open" };
  orders.set(id, order);
  return { merchant: SHOPS[shop].name, orderId: id, checkoutUrl: `${base}/shop/${shop}/checkout/${id}`, amountCents: order.amountCents, total: usd(order.amountCents), item: order.item };
}

export function orderStatus(orderIdOrUrl: string) {
  const id = /o_[a-f0-9]{12}/.exec(orderIdOrUrl)?.[0];
  const o = id ? orders.get(id) : undefined;
  if (!o) throw new Error("no such order");
  return { orderId: o.id, merchant: SHOPS[o.shop].name, item: o.item, amount: usd(o.amountCents), status: o.status, cardLast4: o.last4 ?? null, paidAt: o.paidAt ?? null };
}

export const isShopUrl = (base: string, url: string) => url.startsWith(`${base}/shop/`) && /\/shop\/(kola|ankara)\/checkout\/o_[a-f0-9]{12}$/.test(url);

const shell = (title: string, accent: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;background:#faf7f2;font:16px Georgia,'Times New Roman',serif;color:#2b2118}
.wrap{max-width:560px;margin:40px auto;padding:0 20px}
h1{font-size:30px;margin:0 0 4px;color:${accent}}.sub{color:#7a6a5a;margin:0 0 24px}
.card{background:#fff;border:1px solid #eadfce;border-radius:14px;padding:24px 26px;box-shadow:0 8px 24px #2b211810}
.row{display:flex;justify-content:space-between;margin:6px 0}.due{font-size:20px;font-weight:bold;border-top:1px dashed #d8c8b0;padding-top:10px;margin-top:10px}
label{display:block;margin:14px 0 6px;font-size:14px;color:#5a4a3a}
input,select{width:100%;padding:10px 12px;border:1px solid #d8c8b0;border-radius:8px;font:16px ui-monospace,Menlo,monospace;background:#fffdf9}
.two{display:flex;gap:12px}.two>div{flex:1}
.check{display:flex;gap:8px;align-items:center;margin:12px 0;font-size:14px}.check input{width:auto}
button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:10px;background:${accent};color:#fff;font:bold 17px Georgia,serif;cursor:pointer}
#msg{color:#b3261e;margin-top:12px;min-height:1em}
</style></head><body><div class="wrap">${body}</div></body></html>`;

function checkoutPage(o: Order): string {
  const summary = `<div class="row"><span>${esc(o.item)}</span><span>${usd(o.amountCents)}</span></div>`;
  const submit = (fields: string) => `<script>
document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = ${fields};
  const r = await fetch(location.pathname.replace('/checkout/', '/pay/'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.ok) location.href = j.next; else document.getElementById('msg').textContent = j.message;
});
</script>`;
  if (o.shop === "kola") {
    return shell("Kola Coffee checkout", "#6b3e26", `<h1>Kola Coffee</h1><p class="sub">Roasted in Lagos. Secure checkout.</p>
<div class="card">${summary}<div class="row due"><span>Total</span><span>${usd(o.amountCents)}</span></div>
<form>
  <label for="email">Email for your receipt</label><input id="email" name="email" type="email" autocomplete="email" required>
  <label for="cc-number">Card number</label><input id="cc-number" name="cardnumber" autocomplete="cc-number" inputmode="numeric" required>
  <div class="two"><div><label for="cc-exp">Expiry (MM/YY)</label><input id="cc-exp" name="exp" autocomplete="cc-exp" placeholder="MM/YY" required></div>
  <div><label for="cc-csc">CVC</label><input id="cc-csc" name="cvc" autocomplete="cc-csc" maxlength="4" required></div></div>
  <label for="cc-name">Name on card</label><input id="cc-name" name="ccname" autocomplete="cc-name">
  <label for="zip">ZIP / postal code</label><input id="zip" name="zip" autocomplete="postal-code">
  <button type="submit">Pay ${usd(o.amountCents)}</button><div id="msg"></div>
</form></div>${submit("{ number: document.getElementById('cc-number').value, exp: document.getElementById('cc-exp').value, cvc: document.getElementById('cc-csc').value }")}`);
  }
  const months = Array.from({ length: 12 }, (_, i) => `<option>${String(i + 1).padStart(2, "0")}</option>`).join("");
  const years = Array.from({ length: 12 }, (_, i) => `<option>${new Date().getFullYear() + i}</option>`).join("");
  return shell("Ankara Prints", "#0f6b5c", `<h1>Ankara Prints</h1><p class="sub">Wax-print patterns, printed to order.</p>
<div class="card">${summary}<div class="row due"><span>Amount due</span><span>${usd(o.amountCents)}</span></div>
<form>
  <label for="f1">Long number on the front</label><input id="f1" name="f1" required>
  <div class="two"><div><label for="f2">Good thru (month)</label><select id="f2" name="f2" required><option value="">--</option>${months}</select></div>
  <div><label for="f3">Good thru (year)</label><select id="f3" name="f3" required><option value="">--</option>${years}</select></div></div>
  <label for="f4">3 digits on the back</label><input id="f4" name="f4" maxlength="4" required>
  <label for="f5">Who is paying?</label><input id="f5" name="f5">
  <div class="check"><input type="checkbox" id="terms" required><label for="terms" style="margin:0">I accept the terms of sale</label></div>
  <div class="check"><input type="checkbox" id="news"><label for="news" style="margin:0">Send me the monthly newsletter</label></div>
  <button type="submit">Place my order</button><div id="msg"></div>
</form></div>${submit("{ number: document.getElementById('f1').value, exp: document.getElementById('f2').value + '/' + document.getElementById('f3').value, cvc: document.getElementById('f4').value }")}`);
}

const donePage = (o: Order) => shell("Thank you", o.shop === "kola" ? "#6b3e26" : "#0f6b5c", `<h1>Thank you for your order!</h1>
<div class="card"><p>Payment received: <b>${usd(o.amountCents)}</b> to ${esc(SHOPS[o.shop].name)}.</p><p>${esc(o.item)}</p><p>Card ending ${esc(o.last4 ?? "")}. Test mode: no money moved.</p></div>`);

/** Handles /shop/... requests; returns false when the path is not the shop's. */
export async function handleShop(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const m = /^\/shop\/(kola|ankara)\/(checkout|pay|done)\/(o_[a-f0-9]{12})$/.exec(path);
  if (!m) return false;
  const o = orders.get(m[3]!);
  if (!o || o.shop !== m[1]) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no such order");
    return true;
  }
  const html = (s: string) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(s);
  };
  if (req.method === "GET" && m[2] === "checkout") {
    if (o.status === "paid") return html(donePage(o)), true;
    return html(checkoutPage(o)), true;
  }
  if (req.method === "GET" && m[2] === "done") return html(o.status === "paid" ? donePage(o) : checkoutPage(o)), true;
  if (req.method === "POST" && m[2] === "pay") {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 2_000) break;
    }
    let b: { number?: string; exp?: string; cvc?: string } = {};
    try {
      b = JSON.parse(raw);
    } catch { /* empty */ }
    const num = String(b.number ?? "").replace(/\D/g, "");
    const reply = (ok: boolean, extra: Record<string, unknown>) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, ...extra }));
    };
    if (o.status === "paid") return reply(true, { next: `/shop/${o.shop}/done/${o.id}` }), true;
    // Test cards only: anything else is refused and not kept.
    if (!TEST_CARDS.has(num) || !/^\d{2}\/\d{2,4}$/.test(String(b.exp ?? "")) || !/^\d{3,4}$/.test(String(b.cvc ?? ""))) {
      o.status = "declined";
      return reply(false, { message: "Your card was declined." }), true;
    }
    o.status = "paid";
    o.last4 = num.slice(-4);
    o.paidAt = new Date().toISOString();
    return reply(true, { next: `/shop/${o.shop}/done/${o.id}` }), true;
  }
  res.writeHead(405);
  res.end();
  return true;
}
