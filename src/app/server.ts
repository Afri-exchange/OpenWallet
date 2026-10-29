import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkoutPage, type CheckoutService } from "./checkout.js";
import { buildAgentMcpServer } from "./mcp.js";
import { AppError, type AgentPrincipal, type AppService } from "./service.js";
import type { SwapRequest, SwapService } from "../checkout-swap/swap.js";
import type { DeveloperService } from "../developers/service.js";
import { CircleError, type CircleDeposits } from "../chain/circle.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "web");
/** Page routes and the only files served under /assets. Anything else is a 404, so no path can leave WEB. */
const PAGES: Record<string, string> = { "/": "index.html", "/docs": "docs.html", "/docs/checkout": "docs-checkout.html","/app": "app.html", "/connect": "connect.html" };
const ASSETS = new Set(["site.css", "site.js", "app.js", "docs.js", "home.js", "landing.js", "connect.js"]);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
// Scripts and styles only from ourselves; inline styles are allowed (generated markup uses style=""), inline scripts never.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

interface Served { mtime: number; etag: string; type: string; raw: Buffer; br: Buffer; gz: Buffer }
const served = new Map<string, Served>();

/** Reads a web file once per change (checked by mtime), pre-compressed, so a request is a map lookup. */
function webFile(name: string): Served {
  const file = join(WEB, name);
  const mtime = statSync(file).mtimeMs;
  const hit = served.get(name);
  if (hit && hit.mtime === mtime) return hit;
  const raw = readFileSync(file);
  const next: Served = {
    mtime, raw, type: TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
    etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 22)}"`,
    br: brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }),
    gz: gzipSync(raw, { level: 9 }),
  };
  served.set(name, next);
  return next;
}

function sendFile(req: IncomingMessage, res: ServerResponse, name: string, page: boolean): void {
  const f = webFile(name);
  const headers: Record<string, string> = {
    "content-type": f.type, etag: f.etag, vary: "accept-encoding",
    // Revalidate every time: a 304 costs one round trip and there are no hashed file names to cache forever.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  };
  if (page) { headers["content-security-policy"] = CSP; headers["x-frame-options"] = "DENY"; }
  if (req.headers["if-none-match"] === f.etag) { res.writeHead(304, headers); res.end(); return; }
  const accept = String(req.headers["accept-encoding"] ?? "");
  const [body, enc] = /\bbr\b/.test(accept) ? [f.br, "br"] : /\bgzip\b/.test(accept) ? [f.gz, "gzip"] : [f.raw, ""];
  if (enc) headers["content-encoding"] = enc;
  headers["content-length"] = String(body.length);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
const MAX_BODY = 2_000_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

async function readRaw(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bearer(req: IncomingMessage): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return m?.[1];
}

/**
 * HTTP surface, localhost only:
 *   /  /docs  /app        landing, documentation, owner dashboard + developer section (static pages in ./web)
 *   /assets/...            their scripts and styles
 *   /api/...               owner API, `Authorization: Bearer uk_...` (POST /api/me/token replaces the token)
 * Every POST must be `content-type: application/json`, and a browser Origin must be one of ours.
 *   /agent/v1/...          agent REST API, `Authorization: Bearer ak_...` (hosted-checkouts/...: third-party checkouts, when swap is on)
 *   /mcp                   MCP (streamable HTTP, stateless), `Authorization: Bearer ak_...`
 *   /merchant/v1/...       merchant checkout, balance and payout API, `Authorization: Bearer mk_...` (POST /merchant/v1/signup is open)
 *   /pay/<id>  /v1/checkouts/<id>   a checkout's public page and JSON (the unguessable id is the access)
 */
export function createAppServer(app: AppService, opts: { allowedHosts: string[]; checkout?: CheckoutService; swap?: SwapService; developers?: DeveloperService; circle?: CircleDeposits; webhookOnlyHosts?: string[]; log?: (m: string) => void }): Server {
  const log = opts.log ?? (() => undefined);
  const allowed = new Set([...opts.allowedHosts, ...(opts.webhookOnlyHosts ?? [])].map((h) => h.toLowerCase()));
  // https too: behind a TLS tunnel the browser sends https://<host>; the host itself must still be allowed.
  // Public tunnel hosts: they may only reach the Circle webhook and the health check, never the dashboard or APIs.
  const webhookOnly = new Set((opts.webhookOnlyHosts ?? []).map((h) => h.toLowerCase()));
  const allowedOrigins = new Set([...allowed].flatMap((h) => [`http://${h}`, `https://${h}`]));

  // The owner API takes the owner's token (uk_) or a developer-issued session (us_, short-lived).
  const userOf = async (req: IncomingMessage, opts2: { ownerTokenOnly?: boolean } = {}): Promise<string> => {
    const t = bearer(req);
    const id = t && t.startsWith("uk_") ? await app.userByToken(t)
      : t && t.startsWith("us_") && !opts2.ownerTokenOnly ? await app.userBySession(t)
      : undefined;
    if (!id) throw new HttpError(401, "missing or invalid user token");
    return id;
  };
  const developers = (): DeveloperService => {
    if (!opts.developers) throw new HttpError(404, "the developer API is not enabled on this server");
    return opts.developers;
  };
  const developerOf = async (req: IncomingMessage): Promise<string> => {
    const t = bearer(req);
    const id = t && t.startsWith("dk_") ? await developers().byKey(t) : undefined;
    if (!id) throw new HttpError(401, "missing or invalid developer key");
    return id;
  };
  const agentOf = async (req: IncomingMessage): Promise<AgentPrincipal> => {
    const t = bearer(req);
    const a = t && t.startsWith("ak_") ? await app.agentByToken(t) : undefined;
    if (!a) throw new HttpError(401, "missing, invalid or revoked agent token");
    return a;
  };
  const checkouts = (): CheckoutService => {
    if (!opts.checkout) throw new HttpError(404, "checkouts are not enabled on this server");
    return opts.checkout;
  };
  const swaps = (): SwapService => {
    if (!opts.swap) throw new HttpError(404, "paying hosted checkouts is not enabled on this server");
    return opts.swap;
  };
  const merchantOf = async (req: IncomingMessage): Promise<string> => {
    const t = bearer(req);
    const id = t && t.startsWith("mk_") ? await checkouts().merchantByKey(t) : undefined;
    if (!id) throw new HttpError(401, "missing or invalid merchant secret key");
    return id;
  };
  const agentApi = (p: AgentPrincipal) => ({
    wallet: () => app.agentWallet(p),
    pay: (r: Parameters<AppService["pay"]>[1]) => app.pay(p, r),
    transactions: (limit?: number) => app.agentTransactions(p, limit),
    getCheckout: (id: string) => checkouts().getPublic(id),
    payCheckout: (id: string, maxAmountCents?: number) => checkouts().pay(p, id, { maxAmountCents }),
    payHostedCheckout: (r: SwapRequest) => swaps().pay(p, r),
    getHostedCheckoutPayment: (id: string) => swaps().get(p, id),
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding guard: a browser page on another site cannot reach us under its own hostname.
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowed.has(host)) throw new HttpError(421, "unexpected Host header");
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    const m = req.method ?? "GET";
    if (webhookOnly.has(host) && path !== "/webhooks/circle" && path !== "/healthz") throw new HttpError(404, "not found");
    if (m === "POST") {
      // Cross-site forms and text/plain fetches skip the CORS preflight; requiring JSON forces one, and a
      // browser Origin from anywhere else is refused outright.
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) throw new HttpError(403, "cross-origin request refused");
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "content-type must be application/json");
    }

    if ((m === "GET" || m === "HEAD") && PAGES[path.length > 1 ? path.replace(/\/$/, "") : path]) {
      return sendFile(req, res, PAGES[path.length > 1 ? path.replace(/\/$/, "") : path]!, true);
    }
    if ((m === "GET" || m === "HEAD") && path.startsWith("/assets/")) {
      const name = path.slice(8);
      if (!ASSETS.has(name)) throw new HttpError(404, "not found");
      return sendFile(req, res, name, false);
    }
    if (m === "GET" && path === "/healthz") return send(res, 200, { ok: true });

    // Circle deposit webhooks: signed by Circle, verified over the raw body. A non-2xx makes Circle retry.
    if (m === "POST" && path === "/webhooks/circle") {
      if (!opts.circle) throw new HttpError(404, "Circle deposits are not enabled on this server");
      const h = (n: string): string | undefined => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; };
      try {
        const r = await opts.circle.handle(await readRaw(req), { signature: h("x-circle-signature"), keyId: h("x-circle-key-id") });
        if (r.status === "ignored" && !/^type /.test(r.reason)) log(`circle webhook ignored: ${r.reason}`);
        return send(res, 200, { ok: true, status: r.status });
      } catch (e) {
        if (e instanceof CircleError && e.status === 401) { log(`circle webhook refused: ${e.message}`); throw new HttpError(401, "invalid signature"); }
        throw e;
      }
    }

    // ----- public checkout page and JSON -----
    const pub = /^\/(pay|v1\/checkouts)\/(cs_[a-f0-9]{32})$/.exec(path);
    if ((m === "GET" || m === "HEAD") && pub) {
      const c = await checkouts().getPublic(pub[2]!);
      if (pub[1] !== "pay") return send(res, 200, c);
      const body = Buffer.from(checkoutPage(c));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store",
        "content-security-policy": CSP, "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      });
      return void res.end(m === "HEAD" ? undefined : body);
    }

    // ----- MCP -----
    if (path === "/mcp") {
      if (m !== "POST") return send(res, 405, { error: "stateless MCP endpoint: POST only" });
      const principal = await agentOf(req);
      const body = await readJson(req);
      const server = buildAgentMcpServer(agentApi(principal));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // ----- agent REST -----
    if (path.startsWith("/agent/v1/")) {
      const p = await agentOf(req);
      if (m === "GET" && path === "/agent/v1/wallet") return send(res, 200, await app.agentWallet(p));
      if (m === "GET" && path === "/agent/v1/transactions") return send(res, 200, await app.agentTransactions(p, Math.trunc(Number(url.searchParams.get("limit") ?? 20)) || 20));
      if (m === "POST" && path === "/agent/v1/pay") {
        const b = await readJson(req);
        return send(res, 200, await app.pay(p, {
          amountCents: b.amountCents as number,
          merchant: b.merchant as string,
          mcc: b.mcc as string | undefined,
          idempotencyKey: b.idempotencyKey as string | undefined,
        }));
      }
      const ac = /^\/agent\/v1\/checkouts\/([A-Za-z0-9_]+)(\/pay)?$/.exec(path);
      if (ac && m === "GET" && !ac[2]) return send(res, 200, await checkouts().getPublic(ac[1]!));
      if (ac && m === "POST" && ac[2]) {
        const b = await readJson(req);
        return send(res, 200, await checkouts().pay(p, ac[1]!, { maxAmountCents: b.maxAmountCents }));
      }
      // Hosted (third-party) checkouts paid by swapping in the owner's card.
      if (m === "POST" && path === "/agent/v1/hosted-checkouts/pay") {
        const b = await readJson(req);
        return send(res, 200, await swaps().pay(p, {
          checkoutUrl: b.checkoutUrl as string,
          amountCents: b.amountCents as number,
          merchant: b.merchant as string,
          mcc: b.mcc as string | undefined,
          idempotencyKey: b.idempotencyKey as string,
        }));
      }
      if (m === "GET" && path === "/agent/v1/hosted-checkouts") return send(res, 200, await swaps().list(p, Math.trunc(Number(url.searchParams.get("limit") ?? 20)) || 20));
      const hc = /^\/agent\/v1\/hosted-checkouts\/(sw_[a-f0-9]{24})$/.exec(path);
      if (hc && m === "GET") return send(res, 200, await swaps().get(p, hc[1]!));
      throw new HttpError(404, "not found");
    }

    // ----- merchant checkout API -----
    if (m === "POST" && path === "/merchant/v1/signup") return send(res, 201, await checkouts().createMerchant(await readJson(req)));
    if (path.startsWith("/merchant/v1/")) {
      const merchantId = await merchantOf(req);
      if (m === "GET" && path === "/merchant/v1/me") return send(res, 200, await checkouts().merchantProfile(merchantId));
      if (m === "POST" && path === "/merchant/v1/key") return send(res, 200, await checkouts().rotateMerchantKey(merchantId));
      if (m === "POST" && path === "/merchant/v1/payout-address") return send(res, 200, await checkouts().setPayoutAddress(merchantId, await readJson(req)));
      if (m === "GET" && path === "/merchant/v1/balance") return send(res, 200, await checkouts().balance(merchantId));
      if (m === "GET" && path === "/merchant/v1/payouts") return send(res, 200, await checkouts().listPayouts(merchantId, Math.trunc(Number(url.searchParams.get("limit") ?? 20)) || 20));
      if (m === "POST" && path === "/merchant/v1/payouts") return send(res, 201, await checkouts().requestPayout(merchantId, await readJson(req)));
      if (m === "POST" && path === "/merchant/v1/checkouts") return send(res, 201, await checkouts().create(merchantId, await readJson(req)));
      if (m === "GET" && path === "/merchant/v1/checkouts") return send(res, 200, await checkouts().list(merchantId, Math.trunc(Number(url.searchParams.get("limit") ?? 20)) || 20));
      const mc = /^\/merchant\/v1\/checkouts\/([A-Za-z0-9_]+)(\/cancel)?$/.exec(path);
      if (mc && m === "GET" && !mc[2]) return send(res, 200, await checkouts().getForMerchant(merchantId, mc[1]!));
      if (mc && m === "POST" && mc[2]) return send(res, 200, await checkouts().cancel(merchantId, mc[1]!));
      throw new HttpError(404, "not found");
    }

    // ----- developer API -----
    if (m === "POST" && path === "/developer/v1/signup") return send(res, 201, await developers().signup(await readJson(req)));
    if (path.startsWith("/developer/v1/")) {
      const dev = await developerOf(req);
      const lim = Math.trunc(Number(url.searchParams.get("limit") ?? 20)) || 20;
      if (m === "GET" && path === "/developer/v1/me") return send(res, 200, await developers().profile(dev));
      if (m === "POST" && path === "/developer/v1/key") return send(res, 200, await developers().rotateKey(dev));
      if (m === "POST" && path === "/developer/v1/settings") return send(res, 200, await developers().updateSettings(dev, await readJson(req)));
      if (m === "GET" && path === "/developer/v1/events") return send(res, 200, await developers().listEvents(dev, lim));
      if (m === "POST" && path === "/developer/v1/users") {
        const r = await developers().createUser(dev, await readJson(req));
        return send(res, r.created ? 201 : 200, r.user);
      }
      if (m === "GET" && path === "/developer/v1/users") return send(res, 200, await developers().listUsers(dev, lim, url.searchParams.get("externalId") ?? undefined));
      const du = /^\/developer\/v1\/users\/(u_[a-f0-9]+)(?:\/(sessions|agents)(?:\/(a_[a-f0-9]+)\/(fund|reclaim|revoke|limits))?)?$/.exec(path);
      if (du) {
        const [, uid, sub, aid, action] = du as unknown as [string, string, string | undefined, string | undefined, string | undefined];
        if (!sub && m === "GET") return send(res, 200, await developers().userView(dev, uid));
        if (sub === "sessions" && m === "DELETE") return send(res, 200, await developers().revokeSessions(dev, uid));
        if (sub === "sessions" && m === "POST") return send(res, 201, await developers().createSession(dev, uid, (await readJson(req)).ttlSeconds));
        if (sub === "agents" && !aid && m === "POST") return send(res, 201, await developers().createAgent(dev, uid, await readJson(req)));
        if (sub === "agents" && aid && action && m === "POST") {
          const b = await readJson(req);
          if (action === "limits") return send(res, 200, await developers().updateAgentLimits(dev, uid, aid, b));
          if (action === "fund") await developers().fundAgent(dev, uid, aid, b.amountCents, b.key);
          if (action === "reclaim") return send(res, 200, { reclaimedCents: await developers().reclaimAgent(dev, uid, aid, b.amountCents) });
          if (action === "revoke") await developers().revokeAgent(dev, uid, aid);
          return send(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, "not found");
    }

    // ----- owner API -----
    if (m === "POST" && path === "/api/signup") {
      const b = await readJson(req);
      return send(res, 201, await app.signup(b.email));
    }
    if (path.startsWith("/api/me")) {
      const userId = await userOf(req);
      if (m === "GET" && path === "/api/me") return send(res, 200, await app.overview(userId));
      if (m === "POST" && path === "/api/me/token") {
        // A session must not mint a permanent token.
        await userOf(req, { ownerTokenOnly: true });
        return send(res, 200, await app.rotateToken(userId));
      }
      if (m === "POST" && path === "/api/me/kyc") return send(res, 200, await app.submitKyc(userId, await readJson(req)));
      if (m === "POST" && path === "/api/me/refresh") {
        await app.refresh(userId);
        return send(res, 200, await app.overview(userId));
      }
      if (m === "POST" && path === "/api/me/simulate-deposit") {
        await app.simulateDeposit(userId, (await readJson(req)).amountCents);
        return send(res, 202, { ok: true });
      }
      if (m === "POST" && path === "/api/me/agents") return send(res, 201, await app.createAgent(userId, await readJson(req)));
      const am = /^\/api\/me\/agents\/([A-Za-z0-9_]+)\/(fund|reclaim|revoke|limits)$/.exec(path);
      if (m === "POST" && am) {
        const [, agentId, action] = am as unknown as [string, string, string];
        const b = await readJson(req);
        if (action === "fund") await app.fundAgent(userId, agentId, b.amountCents, b.key);
        if (action === "reclaim") await app.reclaimAgent(userId, agentId, b.amountCents);
        if (action === "revoke") await app.revokeAgent(userId, agentId);
        if (action === "limits") return send(res, 200, await app.updateAgentLimits(userId, agentId, b));
        return send(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, "not found");
  }

  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError || e instanceof AppError ? e.status : 500;
      if (status === 500) log(`500 ${req.method} ${req.url?.split("?")[0]}: ${e instanceof Error ? e.message : String(e)}`);
      if (res.headersSent) return void res.end();
      send(res, status, { error: status === 500 ? "internal error" : (e as Error).message });
    });
  });
}
