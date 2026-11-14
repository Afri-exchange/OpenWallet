// Runs the shop through the real SDK against an in-memory stand-in for the agent-cards HTTP API
// (shapes from sdk/checkout/README.md). It checks the shop's own behaviour, not the payment service.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { AgentCardsAgent, AgentCardsCheckout } from "../../sdk/checkout/src/index.ts";
import { createShop } from "./server.ts";

const id = () => "cs_" + [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
const store = new Map<string, Record<string, any>>();
const created: Array<Record<string, any>> = [];
let api: Server, shop: Server, shopUrl: string;

before(async () => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const out = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const body = raw ? JSON.parse(raw) : {};
      const m = /^\/(merchant|agent)\/v1\/checkouts(?:\/(cs_[a-f0-9]{32}))?(\/cancel|\/pay)?$/.exec(req.url!);
      if (!m) return out(404, { error: "nope" });
      if (req.method === "POST" && !m[2]) {
        created.push(body);
        const c = { checkoutId: id(), status: "open", amountCents: body.amountCents, currency: "USD", description: body.description, reference: body.reference ?? null,
          mcc: null, metadata: body.metadata ?? null, checkoutUrl: "", expiresAt: "2099-01-01T00:00:00Z", paidAt: null, createdAt: "", payment: null, lastAttempt: null, underReview: null };
        c.checkoutUrl = `http://127.0.0.1/pay/${c.checkoutId}`;
        store.set(c.checkoutId, c);
        return out(201, c);
      }
      const c = store.get(m[2]!);
      if (!c) return out(404, { error: "no such checkout" });
      if (m[3] === "/cancel") return c.status === "open" ? out(200, Object.assign(c, { status: "canceled" })) : out(409, { error: "only an open checkout can be canceled" });
      if (m[3] === "/pay") {
        if (body.maxAmountCents !== undefined && c.amountCents > body.maxAmountCents) return out(409, { error: "price is above maxAmountCents" });
        Object.assign(c, { status: "paid", paidAt: "now" });
        return out(200, { checkout: c, payment: { status: "approved" } });
      }
      out(200, c);
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  shop = createShop({
    checkout: new AgentCardsCheckout({ baseUrl, secretKey: "mk_test" }),
    agent: new AgentCardsAgent({ baseUrl, token: "ak_test" }),
  });
  await new Promise<void>((r) => shop.listen(0, "127.0.0.1", r));
  shopUrl = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;
});
after(() => { api.close(); shop.close(); });

const post = (path: string, body: unknown) =>
  fetch(shopUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the shop page lists products", async () => {
  const html = await (await fetch(shopUrl + "/")).text();
  assert.match(html, /Lagos Roast Beans/);
  assert.match(html, /Add to cart/);
});

test("checkout prices the cart on the server and the order page carries the SDK button and meta tag", async () => {
  const r = await post("/api/checkout", { cart: [{ id: "beans", qty: 2 }, { id: "mug", qty: 1 }, { id: "beans", qty: 1 }], priceCents: 1 });
  assert.equal(r.status, 201);
  const { orderId } = (await r.json()) as { orderId: string };
  const sent = created.at(-1)!;
  assert.equal(sent.amountCents, 3 * 1450 + 1800);
  assert.equal(sent.idempotencyKey, orderId);
  const page = await (await fetch(`${shopUrl}/order/${orderId}`)).text();
  assert.match(page, /<meta name="agent-cards-checkout" content="cs_[a-f0-9]{32}">/);
  assert.match(page, /data-agent-cards-checkout="cs_/);
  assert.match(page, /Pay \$61\.50 with Agent Card/);
});

test("rejects empty, unknown and out-of-range carts without creating a checkout", async () => {
  const before = created.length;
  for (const cart of [[], [{ id: "nope", qty: 1 }], [{ id: "beans", qty: 0 }], [{ id: "beans", qty: 1.5 }], [{ id: "beans", qty: "2" }], "x"]) {
    const r = await post("/api/checkout", { cart });
    assert.equal(r.status, 400, JSON.stringify(cart));
  }
  assert.equal(created.length, before);
});

test("an order is fulfilled only once the checkout is paid, then stays fulfilled", async () => {
  const { orderId } = (await (await post("/api/checkout", { cart: [{ id: "kettle", qty: 1 }] })).json()) as { orderId: string };
  const open = await (await fetch(`${shopUrl}/api/orders/${orderId}`)).json();
  assert.deepEqual([open.status, open.fulfilled], ["open", false]);
  const paid = await (await post(`/api/orders/${orderId}/demo-pay`, {})).json();
  assert.deepEqual([paid.status, paid.fulfilled], ["paid", true]);
  assert.equal((await (await fetch(`${shopUrl}/api/orders/${orderId}`)).json()).fulfilled, true);
});

test("canceling an open order works; canceling a paid one reports paid", async () => {
  const a = (await (await post("/api/checkout", { cart: [{ id: "mug", qty: 1 }] })).json()) as { orderId: string };
  assert.equal((await (await post(`/api/orders/${a.orderId}/cancel`, {})).json()).status, "canceled");
  const b = (await (await post("/api/checkout", { cart: [{ id: "mug", qty: 1 }] })).json()) as { orderId: string };
  await post(`/api/orders/${b.orderId}/demo-pay`, {});
  assert.equal((await (await post(`/api/orders/${b.orderId}/cancel`, {})).json()).status, "paid");
});

test("unknown orders are a 404, not a crash", async () => {
  assert.equal((await fetch(`${shopUrl}/order/0000000000000000`)).status, 404);
  assert.equal((await fetch(`${shopUrl}/api/orders/0000000000000000`)).status, 404);
});
