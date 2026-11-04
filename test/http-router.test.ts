// The HTTP layer (router -> routes -> controllers) against stub interactors: no database, no Miden.
// Checks every route reaches the right interactor method with the right arguments, and that guards, auth
// order, optional features and the error handler behave as the original single-file server did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/createHttpServer.js";
import type { AgentCardsApp } from "../src/createApp.js";
import { conflictError } from "../src/errors.js";

type Call = [string, ...unknown[]];
const AGENT = { cardId: "c_1", agentId: "a_1", name: "bot", userId: "u_1" };
const CS = `cs_${"a".repeat(32)}`;
const SW = `sw_${"b".repeat(24)}`;

/** A stub that records calls and returns `{ method }` unless told otherwise. */
function stub(calls: Call[], area: string, overrides: Record<string, (...a: unknown[]) => unknown> = {}): any {
  return new Proxy({}, {
    get: (_t, name: string) => async (...args: unknown[]) => {
      calls.push([`${area}.${name}`, ...args]);
      if (overrides[name]) return overrides[name]!(...args);
      return { method: name };
    },
  });
}

async function serve(app: AgentCardsApp, extra: { webhookOnlyHosts?: string[] } = {}) {
  const probe = createAppServer(app, { allowedHosts: [] });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  const logs: string[] = [];
  const server = createAppServer(app, { allowedHosts: [`127.0.0.1:${port}`], ...extra, log: (m) => logs.push(m) });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (method === "POST" && !headers["content-type"]) headers["content-type"] = "application/json";
    const r = await fetch(url + path, { method, headers, body: opts.body === undefined ? (method === "POST" ? "{}" : undefined) : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) });
    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { port, url, call, logs, close: () => server.close() };
}

function fullApp(calls: Call[]): AgentCardsApp {
  return {
    cardholders: stub(calls, "cardholders", {
      userByToken: (t) => (t === "uk_good" ? "u_1" : undefined),
      userBySession: (t) => (t === "us_good" ? "u_1" : undefined),
      agentByToken: (t) => (t === "ak_good" ? AGENT : undefined),
      reclaimAgent: () => 123,
    }),
    checkouts: stub(calls, "checkouts", {
      merchantByKey: (t) => (t === "mk_good" ? "m_1" : undefined),
      getPublic: (id) => (id === CS ? { checkoutId: CS, merchant: "Shop", description: "Thing", amountCents: 250, currency: "USD", status: "open", expiresAt: "2026-01-01T00:00:00Z" } : { method: "getPublic" }),
    }),
    swaps: stub(calls, "swaps"),
    developers: stub(calls, "developers", {
      byKey: (t) => (t === "dk_good" ? "d_1" : undefined),
      createUser: () => ({ created: false, user: { userId: "u_9" } }),
      reclaimAgent: () => 77,
    }),
  };
}

const last = (calls: Call[]) => calls[calls.length - 1];

test("routes reach the right interactor with the right arguments", async () => {
  const calls: Call[] = [];
  const s = await serve(fullApp(calls));
  try {
    const cases: Array<[string, string, { token?: string; body?: unknown }, number, Call, unknown?]> = [
      // owner
      ["POST", "/api/signup", { body: { email: "a@b.c" } }, 201, ["cardholders.signup", "a@b.c"]],
      ["GET", "/api/me", { token: "uk_good" }, 200, ["cardholders.overview", "u_1"]],
      ["GET", "/api/me", { token: "us_good" }, 200, ["cardholders.overview", "u_1"]],
      ["POST", "/api/me/token", { token: "uk_good" }, 200, ["cardholders.rotateToken", "u_1"]],
      ["POST", "/api/me/kyc", { token: "uk_good", body: { firstName: "A" } }, 200, ["cardholders.submitKyc", "u_1", { firstName: "A" }]],
      ["POST", "/api/me/refresh", { token: "uk_good" }, 200, ["cardholders.overview", "u_1"]],
      ["POST", "/api/me/simulate-deposit", { token: "uk_good", body: { amountCents: 5 } }, 202, ["cardholders.simulateDeposit", "u_1", 5], { ok: true }],
      ["POST", "/api/me/simulate-chain-deposit", { token: "uk_good", body: { id: "sim_x" } }, 202, ["cardholders.simulateChainDeposit", "u_1", "sim_x"], { ok: true, method: "simulateChainDeposit" }],
      ["POST", "/api/me/agents", { token: "uk_good", body: { name: "n" } }, 201, ["cardholders.createAgent", "u_1", { name: "n" }]],
      ["POST", "/api/me/agents/a_1/fund", { token: "uk_good", body: { amountCents: 9, key: "k" } }, 200, ["cardholders.fundAgent", "u_1", "a_1", 9, "k"], { ok: true }],
      ["POST", "/api/me/agents/a_1/reclaim", { token: "uk_good", body: { amountCents: 9 } }, 200, ["cardholders.reclaimAgent", "u_1", "a_1", 9], { ok: true }],
      ["POST", "/api/me/agents/a_1/revoke", { token: "uk_good" }, 200, ["cardholders.revokeAgent", "u_1", "a_1"], { ok: true }],
      ["POST", "/api/me/agents/a_1/limits", { token: "uk_good", body: { dailyCents: 1 } }, 200, ["cardholders.updateAgentLimits", "u_1", "a_1", { dailyCents: 1 }]],
      // agent
      ["GET", "/agent/v1/wallet", { token: "ak_good" }, 200, ["cardholders.agentWallet", AGENT]],
      ["GET", "/agent/v1/transactions?limit=5", { token: "ak_good" }, 200, ["cardholders.agentTransactions", AGENT, 5]],
      ["GET", "/agent/v1/transactions?limit=abc", { token: "ak_good" }, 200, ["cardholders.agentTransactions", AGENT, 20]],
      ["POST", "/agent/v1/pay", { token: "ak_good", body: { amountCents: 1, merchant: "m", mcc: "5734", idempotencyKey: "i", extra: 1 } }, 200, ["cardholders.pay", AGENT, { amountCents: 1, merchant: "m", mcc: "5734", idempotencyKey: "i" }]],
      ["GET", "/agent/v1/checkouts/cs_1", { token: "ak_good" }, 200, ["checkouts.getPublic", "cs_1"]],
      ["POST", "/agent/v1/checkouts/cs_1/pay", { token: "ak_good", body: { maxAmountCents: 50 } }, 200, ["checkouts.pay", AGENT, "cs_1", { maxAmountCents: 50 }]],
      ["POST", "/agent/v1/hosted-checkouts/pay", { token: "ak_good", body: { checkoutUrl: "u", amountCents: 1, merchant: "m", idempotencyKey: "k" } }, 200, ["swaps.pay", AGENT, { checkoutUrl: "u", amountCents: 1, merchant: "m", mcc: undefined, idempotencyKey: "k" }]],
      ["GET", "/agent/v1/hosted-checkouts", { token: "ak_good" }, 200, ["swaps.list", AGENT, 20]],
      ["GET", `/agent/v1/hosted-checkouts/${SW}`, { token: "ak_good" }, 200, ["swaps.get", AGENT, SW]],
      // merchant
      ["POST", "/merchant/v1/signup", { body: { name: "shop" } }, 201, ["checkouts.createMerchant", { name: "shop" }]],
      ["GET", "/merchant/v1/me", { token: "mk_good" }, 200, ["checkouts.merchantProfile", "m_1"]],
      ["POST", "/merchant/v1/key", { token: "mk_good" }, 200, ["checkouts.rotateMerchantKey", "m_1"]],
      ["POST", "/merchant/v1/payout-address", { token: "mk_good", body: { address: "0x" } }, 200, ["checkouts.setPayoutAddress", "m_1", { address: "0x" }]],
      ["GET", "/merchant/v1/balance", { token: "mk_good" }, 200, ["checkouts.balance", "m_1"]],
      ["GET", "/merchant/v1/payouts?limit=3", { token: "mk_good" }, 200, ["checkouts.listPayouts", "m_1", 3]],
      ["POST", "/merchant/v1/payouts", { token: "mk_good", body: { amountCents: 1 } }, 201, ["checkouts.requestPayout", "m_1", { amountCents: 1 }]],
      ["POST", "/merchant/v1/checkouts", { token: "mk_good", body: { amountCents: 1 } }, 201, ["checkouts.create", "m_1", { amountCents: 1 }]],
      ["GET", "/merchant/v1/checkouts", { token: "mk_good" }, 200, ["checkouts.list", "m_1", 20]],
      ["GET", "/merchant/v1/checkouts/cs_1", { token: "mk_good" }, 200, ["checkouts.getForMerchant", "m_1", "cs_1"]],
      ["POST", "/merchant/v1/checkouts/cs_1/cancel", { token: "mk_good" }, 200, ["checkouts.cancel", "m_1", "cs_1"]],
      // developer
      ["POST", "/developer/v1/signup", { body: { email: "d@e.f" } }, 201, ["developers.signup", { email: "d@e.f" }]],
      ["GET", "/developer/v1/me", { token: "dk_good" }, 200, ["developers.profile", "d_1"]],
      ["POST", "/developer/v1/key", { token: "dk_good" }, 200, ["developers.rotateKey", "d_1"]],
      ["POST", "/developer/v1/settings", { token: "dk_good", body: { webhookUrl: "x" } }, 200, ["developers.updateSettings", "d_1", { webhookUrl: "x" }]],
      ["GET", "/developer/v1/events", { token: "dk_good" }, 200, ["developers.listEvents", "d_1", 20]],
      ["POST", "/developer/v1/users", { token: "dk_good", body: { externalId: "e" } }, 200, ["developers.createUser", "d_1", { externalId: "e" }], { userId: "u_9" }],
      ["GET", "/developer/v1/users?externalId=e&limit=2", { token: "dk_good" }, 200, ["developers.listUsers", "d_1", 2, "e"]],
      ["GET", "/developer/v1/users/u_ab", { token: "dk_good" }, 200, ["developers.userView", "d_1", "u_ab"]],
      ["DELETE", "/developer/v1/users/u_ab/sessions", { token: "dk_good" }, 200, ["developers.revokeSessions", "d_1", "u_ab"]],
      ["POST", "/developer/v1/users/u_ab/sessions", { token: "dk_good", body: { ttlSeconds: 60 } }, 201, ["developers.createSession", "d_1", "u_ab", 60]],
      ["POST", "/developer/v1/users/u_ab/agents", { token: "dk_good", body: { name: "n" } }, 201, ["developers.createAgent", "d_1", "u_ab", { name: "n" }]],
      ["POST", "/developer/v1/users/u_ab/agents/a_cd/fund", { token: "dk_good", body: { amountCents: 3, key: "k" } }, 200, ["developers.fundAgent", "d_1", "u_ab", "a_cd", 3, "k"], { ok: true }],
      ["POST", "/developer/v1/users/u_ab/agents/a_cd/reclaim", { token: "dk_good", body: { amountCents: 3 } }, 200, ["developers.reclaimAgent", "d_1", "u_ab", "a_cd", 3], { reclaimedCents: 77 }],
      ["POST", "/developer/v1/users/u_ab/agents/a_cd/revoke", { token: "dk_good" }, 200, ["developers.revokeAgent", "d_1", "u_ab", "a_cd"], { ok: true }],
      ["POST", "/developer/v1/users/u_ab/agents/a_cd/limits", { token: "dk_good", body: { dailyCents: 1 } }, 200, ["developers.updateAgentLimits", "d_1", "u_ab", "a_cd", { dailyCents: 1 }]],
      // public
      ["GET", `/v1/checkouts/${CS}`, {}, 200, ["checkouts.getPublic", CS], { checkoutId: CS, merchant: "Shop", description: "Thing", amountCents: 250, currency: "USD", status: "open", expiresAt: "2026-01-01T00:00:00Z" }],
    ];
    for (const [method, path, opts, status, expected, body] of cases) {
      const r = await s.call(method, path, opts);
      assert.equal(r.status, status, `${method} ${path}: ${r.text}`);
      assert.deepEqual(last(calls), expected, `${method} ${path}`);
      if (body !== undefined) assert.deepEqual(r.json, body, `${method} ${path} body`);
    }
  } finally {
    s.close();
  }
});

test("auth runs before 404 under each API, and the open signups need no token", async () => {
  const calls: Call[] = [];
  const s = await serve(fullApp(calls));
  try {
    for (const p of ["/agent/v1/nope", "/merchant/v1/nope", "/developer/v1/nope", "/api/me/nope"]) {
      assert.equal((await s.call("GET", p)).status, 401, p);
    }
    assert.equal((await s.call("GET", "/agent/v1/nope", { token: "ak_good" })).status, 404);
    assert.equal((await s.call("GET", "/api/me/", { token: "uk_good" })).status, 404, "trailing slash is not /api/me");
    // A session may not mint a permanent owner token.
    assert.equal((await s.call("POST", "/api/me/token", { token: "us_good" })).status, 401);
    // Wrong token kind for the surface.
    assert.equal((await s.call("GET", "/agent/v1/wallet", { token: "uk_good" })).status, 401);
    assert.equal((await s.call("GET", "/merchant/v1/me", { token: "dk_good" })).status, 401);
    // Path parameters are constrained.
    assert.equal((await s.call("GET", "/agent/v1/hosted-checkouts/sw_short", { token: "ak_good" })).status, 404);
    assert.equal((await s.call("POST", "/developer/v1/users/u_ab/agents/a_cd/explode", { token: "dk_good" })).status, 404);
    assert.equal((await s.call("GET", "/v1/checkouts/cs_short")).status, 404);
    assert.equal((await s.call("GET", "/nowhere")).status, 404);
  } finally {
    s.close();
  }
});

test("guards: Host, content-type, Origin, webhook-only hosts", async () => {
  const s = await serve(fullApp([]), { webhookOnlyHosts: ["tunnel.example"] });
  const raw = (host: string, path: string) => new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port: s.port, path, headers: { host } }, (r) => { r.resume(); resolve(r.statusCode!); }).on("error", reject).end();
  });
  try {
    assert.equal(await raw("evil.example", "/healthz"), 421);
    assert.equal(await raw("tunnel.example", "/healthz"), 200);
    assert.equal(await raw("tunnel.example", "/"), 404);
    assert.equal(await raw("tunnel.example", "/api/me"), 404);
    assert.equal((await s.call("POST", "/api/signup", { headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await s.call("POST", "/api/signup", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await s.call("POST", "/api/signup", { headers: { origin: s.url } })).status, 201);
  } finally {
    s.close();
  }
});

test("bodies: non-object JSON is 400, oversized is 413", async () => {
  const s = await serve(fullApp([]));
  try {
    assert.equal((await s.call("POST", "/api/signup", { body: "[1]" })).status, 400);
    assert.equal((await s.call("POST", "/api/signup", { body: "not json" })).status, 400);
    assert.equal((await s.call("POST", "/api/signup", { body: "" })).status, 201);
    assert.equal((await s.call("POST", "/api/signup", { body: JSON.stringify({ x: "y".repeat(2_100_000) }) })).status, 413);
  } finally {
    s.close();
  }
});

test("pages, assets, healthz, checkout page, MCP method", async () => {
  const s = await serve(fullApp([]));
  try {
    for (const p of ["/", "/docs", "/docs/", "/docs/checkout", "/app", "/connect"]) {
      const r = await s.call("GET", p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type")!, /text\/html/);
      assert.ok(r.headers.get("content-security-policy"));
    }
    assert.equal((await s.call("HEAD", "/app")).status, 200);
    assert.equal((await s.call("GET", "/assets/site.css")).status, 200);
    assert.equal((await s.call("GET", "/assets/secret.txt")).status, 404);
    assert.equal((await s.call("GET", "/assets/../../package.json")).status, 404);
    assert.deepEqual((await s.call("GET", "/healthz")).json, { ok: true });
    assert.equal((await s.call("HEAD", "/healthz")).status, 404);
    const page = await s.call("GET", `/pay/${CS}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(page.text, /Pay Shop \$2.50/);
    assert.equal((await s.call("GET", "/mcp")).status, 405);
    assert.equal((await s.call("POST", "/mcp")).status, 401);
  } finally {
    s.close();
  }
});

test("optional features off: 404 with the reason; merchant/developer auth order kept", async () => {
  const calls: Call[] = [];
  const s = await serve({ cardholders: fullApp(calls).cardholders });
  try {
    const r = await s.call("POST", "/merchant/v1/signup");
    assert.equal(r.status, 404);
    assert.match(r.json.error, /checkouts are not enabled/);
    assert.equal((await s.call("GET", "/merchant/v1/me")).status, 401);
    assert.equal((await s.call("GET", "/merchant/v1/me", { token: "mk_x" })).status, 404);
    assert.match((await s.call("POST", "/developer/v1/signup")).json.error, /developer API is not enabled/);
    assert.match((await s.call("POST", "/agent/v1/hosted-checkouts/pay", { token: "ak_good" })).json.error, /hosted checkouts is not enabled/);
    assert.match((await s.call("GET", `/v1/checkouts/${CS}`)).json.error, /checkouts are not enabled/);
    assert.match((await s.call("POST", "/webhooks/circle")).json.error, /Circle deposits are not enabled/);
  } finally {
    s.close();
  }
});

test("errors: AgentCardsError shows its status and message; anything else is a logged 500 with no detail", async () => {
  const calls: Call[] = [];
  const app = fullApp(calls);
  app.cardholders = stub(calls, "cardholders", {
    agentByToken: () => AGENT,
    pay: () => { throw conflictError("still being confirmed"); },
    agentWallet: () => { throw new Error("db password is hunter2"); },
  });
  const s = await serve(app);
  try {
    const c = await s.call("POST", "/agent/v1/pay", { token: "ak_x" });
    assert.equal(c.status, 409);
    assert.deepEqual(c.json, { error: "still being confirmed" });
    const e = await s.call("GET", "/agent/v1/wallet", { token: "ak_x" });
    assert.equal(e.status, 500);
    assert.deepEqual(e.json, { error: "internal error" });
    assert.ok(s.logs.some((l) => /^500 GET \/agent\/v1\/wallet: db password/.test(l)));
  } finally {
    s.close();
  }
});

test("Circle webhook: raw body reaches the adapter; a bad signature is 401", async () => {
  const seen: Array<{ raw: string; h: unknown }> = [];
  const { CircleError } = await import("../src/lib/clients/circle/CircleClient.js");
  const app: AgentCardsApp = {
    ...fullApp([]),
    circleDeposits: {
      handle: async (raw: string, h: unknown) => {
        seen.push({ raw, h });
        if (raw.includes("bad")) throw new CircleError("bad signature", 401);
        return { status: "ignored", reason: "type x" };
      },
    } as any,
  };
  const s = await serve(app);
  try {
    const body = '{ "a" :1 }';
    const ok = await s.call("POST", "/webhooks/circle", { body, headers: { "x-circle-signature": "sig", "x-circle-key-id": "kid" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, status: "ignored" });
    assert.deepEqual(seen[0], { raw: body, h: { signature: "sig", keyId: "kid" } });
    const bad = await s.call("POST", "/webhooks/circle", { body: '{"bad":1}' });
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.json, { error: "invalid signature" });
  } finally {
    s.close();
  }
});
