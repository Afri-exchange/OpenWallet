// Sample merchant: a tiny coffee shop that takes payment through @agent-cards/checkout.
//
//   AGENT_CARDS_URL=http://127.0.0.1:8787 node --import tsx server.ts      (from examples/shop)
//
// Where the SDK is used, in the order a merchant meets it:
//   1. AgentCardsCheckout.signup()   once, to get a secret key (kept in .merchant-key, never sent to a browser)
//   2. createCheckout()              when the shopper presses "Checkout", priced on the server from the catalogue
//   3. checkoutMetaTag/Button()      on the order page, so an agent browsing it can find and pay the checkout
//   4. retrieveCheckout()            the order is fulfilled only when the checkout reads "paid"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AgentCardsAgent, AgentCardsCheckout, AgentCardsError, checkoutButton, checkoutMetaTag, type Checkout,
} from "../../sdk/checkout/src/index.ts";
import { priceCart, usd, type PricedLine } from "./catalog.ts";
import { orderPage, shopPage } from "./pages.ts";

export interface Order {
  id: string;
  lines: PricedLine[];
  totalCents: number;
  checkoutId: string;
  fulfilledAt: string | null;
}

export interface ShopOptions {
  checkout: AgentCardsCheckout;
  /** Optional: lets the order page offer a "pay as the demo agent" button. */
  agent?: AgentCardsAgent;
  log?: (m: string) => void;
}

export function createShop({ checkout, agent, log = () => {} }: ShopOptions) {
  const orders = new Map<string, Order>();

  const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  async function readJson(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 16_384) throw new HttpError(413, "Request too large.");
      chunks.push(c as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw new HttpError(400, "Bad JSON."); }
  }

  /** The order's state as the browser needs it. The checkout is re-read every time: it is the source of truth. */
  async function status(order: Order) {
    const c: Checkout = await checkout.retrieveCheckout(order.checkoutId);
    // Fulfil exactly once, and only for a settled payment nobody is reviewing.
    if (c.status === "paid" && !c.underReview && !order.fulfilledAt) {
      order.fulfilledAt = new Date().toISOString();
      log(`order ${order.id} paid (${usd(order.totalCents)}): ship it`);
    }
    return {
      status: c.status,
      fulfilled: Boolean(order.fulfilledAt),
      underReview: Boolean(c.underReview),
      lastAttemptFailed: c.lastAttempt === "failed",
      expiresAt: c.expiresAt,
    };
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://shop.local");
    const path = url.pathname;
    const m = req.method ?? "GET";
    try {
      if (m === "GET" && path === "/") return send(res, 200, shopPage(), "text/html");

      if (m === "POST" && path === "/api/checkout") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON.");
        const body = (await readJson(req)) as { cart?: unknown };
        let priced;
        try { priced = priceCart(body.cart); } catch (e) { throw new HttpError(400, (e as Error).message); }
        const id = randomBytes(8).toString("hex");
        const c = await checkout.createCheckout({
          amountCents: priced.totalCents,
          description: `Bean & Brew order: ${priced.lines.map((l) => `${l.qty}× ${l.product.name}`).join(", ")}`.slice(0, 200),
          reference: id,
          idempotencyKey: id,
          expiresInSeconds: 15 * 60,
          metadata: { items: priced.lines.map((l) => ({ id: l.product.id, qty: l.qty })) },
        });
        orders.set(id, { id, lines: priced.lines, totalCents: priced.totalCents, checkoutId: c.checkoutId, fulfilledAt: null });
        return send(res, 201, { orderId: id });
      }

      const om = /^\/(?:api\/)?(?:orders?)\/([a-f0-9]{16})(\/cancel|\/demo-pay)?$/.exec(path);
      if (om) {
        const order = orders.get(om[1]!);
        if (!order) {
          if (m === "GET" && path.startsWith("/order/")) return send(res, 404, orderPage(undefined), "text/html");
          throw new HttpError(404, "We can't find that order.");
        }
        if (m === "GET" && path.startsWith("/order/")) {
          const c = await checkout.retrieveCheckout(order.checkoutId);
          const head = checkoutMetaTag(c);
          const button = c.status === "open" ? checkoutButton(c) : "";
          return send(res, 200, orderPage({ order, checkout: c, head, button, demoAgent: Boolean(agent) }), "text/html");
        }
        if (m === "GET") return send(res, 200, await status(order));
        if (m === "POST" && om[2] === "/cancel") {
          try { await checkout.cancelCheckout(order.checkoutId); } catch (e) {
            if (!(e instanceof AgentCardsError && e.status === 409)) throw e; // already paid or settled: report it below
          }
          return send(res, 200, await status(order));
        }
        if (m === "POST" && om[2] === "/demo-pay") {
          if (!agent) throw new HttpError(404, "No demo agent is configured.");
          // Stand-in for the shopper's own agent. Passing the expected price means a changed price is refused.
          await agent.payCheckout(order.checkoutId, { maxAmountCents: order.totalCents });
          return send(res, 200, await status(order));
        }
      }
      throw new HttpError(404, "Not found.");
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof AgentCardsError) {
        log(`agent-cards ${e.status}: ${e.message}`);
        // Declines (limits, balance) carry a reason the shopper's agent can act on; show it as is.
        return send(res, e.status >= 500 ? 502 : e.status === 401 ? 502 : e.status, { error: e.status === 401 ? "The shop's payment keys are not valid." : e.message });
      }
      log(`error: ${(e as Error).message}`);
      return send(res, 502, { error: "We couldn't reach the payment service. Try again in a moment." });
    }
  };

  return createServer((req, res) => void handler(req, res));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Uses AGENT_CARDS_SECRET_KEY, else the key saved by a previous run, else signs the shop up (once). */
async function merchantKey(baseUrl: string, log: (m: string) => void): Promise<string> {
  if (process.env.AGENT_CARDS_SECRET_KEY) return process.env.AGENT_CARDS_SECRET_KEY;
  const file = fileURLToPath(new URL("./.merchant-key", import.meta.url));
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const { secretKey, merchantId } = await AgentCardsCheckout.signup({ baseUrl }, { name: "Bean & Brew (sample shop)", email: "shop@example.com", mcc: "5499" });
  writeFileSync(file, secretKey + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  log(`signed up as merchant ${merchantId}; secret key saved to examples/shop/.merchant-key`);
  return secretKey;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const baseUrl = process.env.AGENT_CARDS_URL ?? "http://127.0.0.1:8787";
  const port = Number(process.env.PORT ?? 4100);
  const checkout = new AgentCardsCheckout({ baseUrl, secretKey: await merchantKey(baseUrl, log) });
  const token = process.env.AGENT_CARDS_AGENT_TOKEN;
  const agent = token ? new AgentCardsAgent({ baseUrl, token }) : undefined;
  createShop({ checkout, agent, log }).listen(port, "127.0.0.1", () =>
    log(`shop on http://127.0.0.1:${port} (payments via ${baseUrl}${agent ? ", demo agent enabled" : ""})`));
}
