/**
 * Agent chat demo: chat with a Claude agent that holds an Agent Card. Ask it to buy something; it opens a Stripe
 * TEST-mode checkout on the shop's Stripe sandbox account, pays it through Agent Cards (`/agent/v1/hosted-checkouts`),
 * and you watch the service's browser type into the Stripe form, live, next to the chat.
 *
 * Sandbox only. Payments use Stripe's public 4242 test card (the service runs with SWAP_STRIPE_TEST_CARD=1); no real
 * card or money is involved. The live view exists only in that mode.
 *
 * Env: ANTHROPIC_API_KEY, STRIPE_SANDBOX_SECRET_KEY (sk_test_ only), AGENT_CARDS_URL, AGENT_CARDS_AGENT_TOKEN,
 * AGENT_CHAT_PASSCODE (the page asks for it; anyone reaching the port through a tunnel needs it),
 * optional PORT (8790), AGENT_CHAT_HOST (127.0.0.1), AGENT_CHAT_MODEL (claude-opus-5-5).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { SHOPS, createShopOrder, handleShop, isShopUrl, orderStatus, type ShopId } from "./shops.js";

const here = dirname(fileURLToPath(import.meta.url));
const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (!v) throw new Error(`missing ${k} in the environment`);
  return v;
};
const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.AGENT_CHAT_HOST ?? "127.0.0.1";
const MODEL = process.env.AGENT_CHAT_MODEL ?? "claude-opus-5-5";
const CARDS_URL = env("AGENT_CARDS_URL").replace(/\/$/, "");
const CARDS_TOKEN = env("AGENT_CARDS_AGENT_TOKEN");
const STRIPE_KEY = env("STRIPE_SANDBOX_SECRET_KEY");
const PASSCODE = env("AGENT_CHAT_PASSCODE");
if (!STRIPE_KEY.startsWith("sk_test_")) throw new Error("STRIPE_SANDBOX_SECRET_KEY must be a Stripe test key (sk_test_...)");
/** Test only: a fixed script stands in for Claude (buys one sticker pack), so the page can be checked without an API key. */
const SCRIPTED = process.env.AGENT_CHAT_SCRIPTED === "1";
if (!SCRIPTED) env("ANTHROPIC_API_KEY");

const anthropic = SCRIPTED ? undefined : new Anthropic();
const PAGE = readFileSync(join(here, "index.html"), "utf8");
const MERCHANT = "Agent Office Test Shop";
const CAP_CENTS = 1000;
/** Stripe sends the paying browser here. That browser runs on this machine, so localhost works. */
/** Where Agent Cards' browser (on this laptop) reaches this server: Stripe's success page and the demo shops. */
const LOCAL_BASE = process.env.AGENT_CHAT_SUCCESS_BASE ?? `http://localhost:${PORT}`;
const SUCCESS_URL = `${LOCAL_BASE}/thanks?session_id={CHECKOUT_SESSION_ID}`;

// ---------------------------------------------------------------- the shop (sells on the Stripe test account)

const PRODUCTS = [
  { id: "stickers", name: "Developer sticker pack", priceCents: 200, blurb: "Ten vinyl stickers" },
  { id: "coffee", name: "Espresso beans, 250 g", priceCents: 450, blurb: "Single-origin, medium roast" },
  { id: "notebook", name: "Field notes notebook", priceCents: 325, blurb: "Dot grid, 48 pages" },
  { id: "credits", name: "API sandbox credits, 1 month", priceCents: 500, blurb: "For the test environment" },
  { id: "wallpaper", name: "Wallpaper bundle", priceCents: 100, blurb: "Twelve 4K desktop wallpapers" },
] as const;

async function stripe(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<any> {
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${STRIPE_KEY}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Stripe: ${j?.error?.message ?? r.status}`);
  return j;
}

/** cs_test_... from a Stripe Checkout URL (checkout.stripe.com/c/pay/cs_test_...#...). */
const sessionIdOf = (url: string) => /\/(cs_test_[A-Za-z0-9]+)/.exec(url)?.[1];
const isStripeTestUrl = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ((u.host === "checkout.stripe.com" && /\/cs_test_/.test(u.pathname)) || (u.host === "buy.stripe.com" && u.pathname.startsWith("/test_")));
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- Agent Cards (the agent's own API key)

async function cards(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${CARDS_URL}/agent/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${CARDS_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await r.text();
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    j = { error: text.slice(0, 200) };
  }
  if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? j?.message ?? `Agent Cards ${r.status}`);
  return j;
}

// ---------------------------------------------------------------- chat sessions

interface ChatSession {
  id: string;
  history: Anthropic.Beta.BetaMessageParam[];
  busy: boolean;
  /** Checkout URLs this chat is paying right now: the live view forwards only those swaps. */
  paying: Set<string>;
  viewers: Set<ServerResponse>;
  lastSeen: number;
}
const sessions = new Map<string, ChatSession>();
const sessionOf = (req: IncomingMessage): ChatSession | undefined => {
  const sid = /(?:^|;\s*)ac_sid=([a-f0-9]{48})/.exec(req.headers.cookie ?? "")?.[1];
  const s = sid ? sessions.get(sid) : undefined;
  if (s) s.lastSeen = Date.now();
  return s;
};
setInterval(() => {
  for (const [k, s] of sessions) if (Date.now() - s.lastSeen > 12 * 3600_000 && !s.busy) sessions.delete(k);
}, 600_000).unref();

const SYSTEM = `You are the shopping agent in an Agent Cards demo. You hold an Agent Card: a spending budget on a virtual card, with limits set by your owner. You chat with the person testing the demo and buy things for them.

What you can do:
- list_products: three test shops and their products. ${MERCHANT} takes payment through Stripe Checkout (Stripe test mode). ${SHOPS.kola.name} and ${SHOPS.ankara.name} run their own checkout forms that Agent Cards has never seen before: ${SHOPS.kola.name}'s fields are labelled in the standard way, so Agent Cards recognises them itself; ${SHOPS.ankara.name}'s are worded oddly, so Agent Cards asks a model to work out which box is which (that model never sees the card number). Mention this when it helps the person understand what they are watching.
- create_checkout: the chosen shop opens a checkout for a product and quantity. It returns the checkout URL and the exact total.
- pay_checkout: pay a checkout with your Agent Card. Agent Cards opens the page in a browser, checks the total equals what you agreed, types the card in and presses Pay. The person can watch this live in the panel beside the chat. It takes about 15 to 60 seconds.
- check_stripe_payment: ask Stripe directly whether a Stripe checkout session is paid. check_shop_order: ask ${SHOPS.kola.name} or ${SHOPS.ankara.name} whether an order is paid. After every payment, check with the shop and report what it says.
- get_wallet: your balance and limits. list_payments: your recent checkout payments.

Rules:
- This is a sandbox: Stripe test mode, Stripe's public test card, no real money. Say so if asked, and never claim otherwise.
- Before paying, the person must have clearly asked you to buy that item (or confirmed it). If they only ask what is available or what something costs, answer and ask whether to go ahead.
- One payment is at most $${(CAP_CENTS / 100).toFixed(2)} and must fit your per-payment and daily limits; check get_wallet when unsure, and explain plainly if a purchase does not fit.
- The person may paste their own Stripe TEST checkout link (checkout.stripe.com/c/pay/cs_test_... or buy.stripe.com/test_...). You may pay it if they tell you the exact total and ask you to; refuse live (non-test) links.
- Never invent a checkout URL, amount or payment result. Use only what the tools return. If a payment fails or is still processing, say exactly that.
- Keep replies short and friendly. Amounts in dollars.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "list_products", description: "The test shops, their products and prices.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "create_checkout",
    description: "The chosen shop opens a checkout for one product: a Stripe TEST-mode Checkout (shop \"stripe\") or the shop's own checkout form (\"kola\", \"ankara\"). Returns checkoutUrl and amountCents (the exact total to agree to).",
    input_schema: {
      type: "object",
      properties: {
        shop: { type: "string", enum: ["stripe", "kola", "ankara"] },
        productId: { type: "string", enum: [...PRODUCTS.map((p) => p.id), ...SHOPS.kola.products.map((p) => p.id), ...SHOPS.ankara.products.map((p) => p.id)] },
        quantity: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["shop", "productId", "quantity"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "pay_checkout",
    description: "Pay a checkout (a Stripe TEST checkout or a demo shop's checkout URL) with your Agent Card. The page total must equal amountCents exactly or nothing is paid. Paying the same URL twice never charges twice; it returns the first result.",
    input_schema: {
      type: "object",
      properties: {
        checkoutUrl: { type: "string" },
        amountCents: { type: "integer", minimum: 1 },
        merchant: { type: "string", description: "Who is being paid, e.g. the shop's name" },
      },
      required: ["checkoutUrl", "amountCents", "merchant"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "check_stripe_payment",
    description: "Ask Stripe for a checkout session's status (status, payment_status, amount_total). Takes the cs_test_ session id or the checkout URL.",
    input_schema: { type: "object", properties: { sessionIdOrUrl: { type: "string" } }, required: ["sessionIdOrUrl"], additionalProperties: false },
    strict: true,
  },
  {
    name: "check_shop_order",
    description: "Ask Kola Coffee or Ankara Prints for an order's status (open, paid, declined). Takes the order id or the checkout URL.",
    input_schema: { type: "object", properties: { orderIdOrUrl: { type: "string" } }, required: ["orderIdOrUrl"], additionalProperties: false },
    strict: true,
  },
  { name: "get_wallet", description: "Your Agent Card balance, limits and what is left today.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_payments", description: "Your recent hosted-checkout payments.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
];

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Emit = (e: Record<string, unknown>) => void;

async function runTool(s: ChatSession, name: string, input: any, emit: Emit): Promise<unknown> {
  switch (name) {
    case "list_products":
      return {
        shops: [
          { shop: "stripe", merchant: MERCHANT, checkout: "Stripe Checkout (test mode)", products: PRODUCTS.map((p) => ({ ...p, price: usd(p.priceCents) })) },
          ...(["kola", "ankara"] as const).map((id) => ({
            shop: id, merchant: SHOPS[id].name,
            checkout: id === "kola" ? "its own form, standard field labels" : "its own form, unusual wording (mapped by a model)",
            products: SHOPS[id].products.map((p) => ({ ...p, price: usd(p.priceCents) })),
          })),
        ],
        mode: "test: Stripe's public test card, no real money",
      };
    case "get_wallet":
      return cards("GET", "/wallet");
    case "list_payments":
      return (await cards("GET", "/hosted-checkouts?limit=5")) as unknown;
    case "create_checkout": {
      const qty = Number(input.quantity);
      if (input.shop === "kola" || input.shop === "ankara") {
        if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw new Error("bad quantity");
        const out = createShopOrder(LOCAL_BASE, input.shop as ShopId, String(input.productId), qty);
        if (out.amountCents > CAP_CENTS) throw new Error(`that comes to ${out.total}; one payment is capped at ${usd(CAP_CENTS)} in this demo`);
        return out;
      }
      const p = PRODUCTS.find((x) => x.id === input.productId);
      if (!p || !Number.isInteger(qty) || qty < 1 || qty > 10) throw new Error("unknown product or bad quantity");
      const total = p.priceCents * qty;
      if (total > CAP_CENTS) throw new Error(`that comes to ${usd(total)}; one payment is capped at ${usd(CAP_CENTS)} in this demo`);
      const cs = await stripe("POST", "/checkout/sessions", {
        mode: "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(p.priceCents),
        "line_items[0][price_data][product_data][name]": p.name,
        "line_items[0][quantity]": String(qty),
        success_url: SUCCESS_URL,
        "managed_payments[enabled]": "false",
        "metadata[source]": "agent-chat-demo",
      });
      return { merchant: MERCHANT, sessionId: cs.id, checkoutUrl: cs.url, amountCents: cs.amount_total, total: usd(cs.amount_total), item: `${qty} x ${p.name}` };
    }
    case "pay_checkout": {
      const url = String(input.checkoutUrl);
      const amountCents = Number(input.amountCents);
      if (!isStripeTestUrl(url) && !isShopUrl(LOCAL_BASE, url)) throw new Error("only Stripe TEST checkout links (checkout.stripe.com/c/pay/cs_test_... or buy.stripe.com/test_...) and the demo shops' checkouts can be paid in this demo");
      if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > CAP_CENTS) throw new Error(`amount must be between 1 cent and ${usd(CAP_CENTS)}`);
      // One key per checkout URL: asking twice can never pay twice.
      const idempotencyKey = `chat-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
      const href = new URL(url).href; // as Agent Cards stores it, to match its live events
      s.paying.add(href);
      emit({ type: "paying", merchant: input.merchant, amount: usd(amountCents) });
      try {
        let v = await cards("POST", "/hosted-checkouts/pay", { checkoutUrl: url, amountCents, merchant: String(input.merchant).slice(0, 80), idempotencyKey });
        // "processing": submitted, answer not clear yet; the service settles it in the background.
        for (let i = 0; i < 12 && (v.status === "processing" || v.status === "pending" || v.status === "filling"); i++) {
          await sleep(5_000);
          v = await cards("GET", `/hosted-checkouts/${v.swapId}`);
        }
        return v;
      } finally {
        s.paying.delete(href);
      }
    }
    case "check_shop_order":
      return orderStatus(String(input.orderIdOrUrl));
    case "check_stripe_payment": {
      const raw = String(input.sessionIdOrUrl);
      const id = raw.startsWith("cs_test_") ? raw : sessionIdOf(raw);
      if (!id || !/^cs_test_[A-Za-z0-9]+$/.test(id)) throw new Error("need a cs_test_ checkout session id (or its checkout URL)");
      const cs = await stripe("GET", `/checkout/sessions/${id}`);
      return { sessionId: cs.id, status: cs.status, payment_status: cs.payment_status, amount_total: cs.amount_total, currency: cs.currency, livemode: cs.livemode };
    }
  }
  throw new Error(`unknown tool ${name}`);
}

/** One user turn: loop Claude <-> tools until Claude answers. Events stream to the browser as NDJSON. */
async function chatTurn(s: ChatSession, text: string, emit: Emit): Promise<void> {
  s.history.push({ role: "user", content: text });
  for (let step = 0; step < 12; step++) {
    const res = SCRIPTED ? scriptedReply(s.history) : await anthropic!.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: s.history,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    // Keep the full content (thinking blocks included) so the history stays valid on the next request.
    s.history.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) emit({ type: "text", text: b.text });
    if (res.stop_reason === "refusal") {
      emit({ type: "text", text: "Sorry, I can't help with that one." });
      return;
    }
    if (res.stop_reason !== "tool_use") return;
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      emit({ type: "tool", name: u.name, input: u.input });
      try {
        const out = await runTool(s, u.name, u.input, emit);
        emit({ type: "tool_result", name: u.name, ok: true, result: out });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: u.name, ok: false, error: msg });
        results.push({ type: "tool_result", tool_use_id: u.id, content: msg, is_error: true });
      }
    }
    s.history.push({ role: "user", content: results });
  }
  emit({ type: "text", text: "(I stopped after too many steps; please try again.)" });
}

function scriptedReply(history: Anthropic.Beta.BetaMessageParam[]): { content: Anthropic.Beta.BetaContentBlock[]; stop_reason: string } {
  const last = history[history.length - 1]!;
  const prior = Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? JSON.parse(String(last.content[0].content)) : undefined;
  const stage = prior === undefined ? 0 : prior.checkoutUrl ? 1 : prior.swapId ? 2 : 3;
  const use = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name, input }] as any, stop_reason: "tool_use" });
  const findIn = (key: string) => {
    for (const m of [...history].reverse()) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") { try { const j = JSON.parse(String(b.content)); if (j[key]) return j; } catch { /* error text */ } }
    return undefined;
  };
  const shop = process.env.AGENT_CHAT_SCRIPTED_SHOP ?? "stripe";
  if (stage === 0) return use("create_checkout", shop === "stripe" ? { shop, productId: "stickers", quantity: 1 } : { shop, productId: SHOPS[shop as ShopId].products[0]!.id, quantity: 1 });
  if (stage === 1) return use("pay_checkout", { checkoutUrl: prior.checkoutUrl, amountCents: prior.amountCents, merchant: MERCHANT });
  if (stage === 2) return shop === "stripe" ? use("check_stripe_payment", { sessionIdOrUrl: findIn("checkoutUrl").sessionId }) : use("check_shop_order", { orderIdOrUrl: findIn("checkoutUrl").orderId });
  return { content: [{ type: "text", text: `(scripted) Done: the shop says ${prior.status}${prior.payment_status ? ` / ${prior.payment_status}` : ""}.` }] as any, stop_reason: "end_turn" };
}

// ---------------------------------------------------------------- live view: one upstream feed, fanned out per chat

const swapOwner = new Map<string, ChatSession>();
const lastFrameAt = new Map<ServerResponse, number>();
function deliver(s: ChatSession, e: any) {
  for (const v of s.viewers) {
    // Frames are big: at most ~8 a second per viewer, so a tunnel keeps up. Steps always go through.
    if (e.type === "frame") {
      const now = Date.now();
      if (now - (lastFrameAt.get(v) ?? 0) < 120) continue;
      lastFrameAt.set(v, now);
    }
    v.write(`data: ${JSON.stringify(e)}\n\n`);
  }
}
async function followLiveFeed(): Promise<never> {
  for (;;) {
    try {
      const r = await fetch(`${CARDS_URL}/agent/v1/hosted-checkouts/live`, { headers: { authorization: `Bearer ${CARDS_TOKEN}` } });
      if (!r.ok || !r.body) throw new Error(`live feed ${r.status}`);
      console.log("live view: connected to Agent Cards");
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          if (e.type === "start") {
            const owner = [...sessions.values()].find((s) => s.paying.has(e.url));
            if (owner) swapOwner.set(e.swapId, owner);
          }
          const owner = swapOwner.get(e.swapId);
          if (owner) deliver(owner, e);
          if (e.type === "end") setTimeout(() => swapOwner.delete(e.swapId), 5_000);
        }
      }
    } catch (e) {
      console.log(`live view: ${e instanceof Error ? e.message : e}; retrying`);
    }
    await sleep(3_000);
  }
}

// ---------------------------------------------------------------- HTTP

const THANKS = `<!doctype html><meta charset="utf-8"><title>Payment complete</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#f6f7fb;font:16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1f36">
<div style="background:#fff;border:1px solid #e3e6ef;border-radius:16px;padding:40px 48px;text-align:center;box-shadow:0 10px 30px #1a1f3612">
<div style="width:64px;height:64px;border-radius:50%;background:#e7f6ef;color:#0e8a5f;font-size:34px;line-height:64px;margin:0 auto 16px">&#10003;</div>
<h1 style="margin:0 0 6px;font-size:24px">Payment complete</h1>
<p style="margin:0;color:#6b7385">${MERCHANT} received your order. Paid by an Agent Card (Stripe test mode).</p></div></body>`;

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 20_000) throw new Error("body too large");
    parts.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}
const passOk = (given: string) => {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(PASSCODE).digest();
  return timingSafeEqual(a, b);
};
const failedLogins = new Map<string, { n: number; until: number }>();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    // The demo shops' pages are public: Agent Cards' browser opens them without a chat login.
    if (url.pathname.startsWith("/shop/") && (await handleShop(req, res, url.pathname))) return;
    if (req.method === "GET" && url.pathname === "/thanks") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(THANKS);
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress);
      const f = failedLogins.get(ip);
      if (f && f.until > Date.now()) return json(res, 429, { error: "too many tries; wait a minute" });
      const { passcode } = await readJson(req);
      if (typeof passcode !== "string" || !passOk(passcode)) {
        const n = (f?.n ?? 0) + 1;
        failedLogins.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
        return json(res, 401, { error: "wrong passcode" });
      }
      failedLogins.delete(ip);
      const id = randomBytes(24).toString("hex");
      sessions.set(id, { id, history: [], busy: false, paying: new Set(), viewers: new Set(), lastSeen: Date.now() });
      const secure = req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https");
      res.setHeader("set-cookie", `ac_sid=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`);
      return json(res, 200, { ok: true });
    }

    const s = sessionOf(req);
    if (url.pathname.startsWith("/api/") && !s) return json(res, 401, { error: "sign in first" });

    if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { ok: true, model: MODEL, wallet: await cards("GET", "/wallet").catch(() => null) });
    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (s!.busy) return json(res, 409, { error: "wait for the current reply" });
      s!.history = [];
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/live") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(": live\n\n");
      s!.viewers.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        s!.viewers.delete(res);
        lastFrameAt.delete(res);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { message } = await readJson(req);
      if (typeof message !== "string" || !message.trim() || message.length > 2000) return json(res, 400, { error: "message must be 1 to 2000 characters" });
      if (s!.busy) return json(res, 409, { error: "still working on the last message" });
      s!.busy = true;
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
      const emit: Emit = (e) => res.write(`${JSON.stringify(e)}\n`);
      const mark = s!.history.length;
      try {
        await chatTurn(s!, message.trim(), emit);
      } catch (e) {
        console.error("chat turn failed:", e instanceof Error ? e.message : e);
        // Drop the half-finished turn so the history stays valid.
        s!.history.length = mark;
        emit({ type: "error", error: e instanceof Anthropic.APIError ? `Claude API error ${e.status ?? ""}`.trim() : "something went wrong; try again" });
      } finally {
        s!.busy = false;
        emit({ type: "done", wallet: await cards("GET", "/wallet").catch(() => null) });
        res.end();
      }
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`agent chat on http://${HOST}:${PORT} (model ${MODEL}, Agent Cards at ${CARDS_URL})`));
void followLiveFeed();
