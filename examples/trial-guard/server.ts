/**
 * Trial Guard demo: "sign me up for these trials". A Claude agent with an Agent Card pays each free trial's $1 card
 * check. The user is in privacy mode, so every payment is a fresh one-time card (one swipe, exactly the amount).
 * "Skip to renewal day" then has each trial shop try to bill the monthly price on the card it was given, through
 * Miden's sandbox authorization simulator, and the page shows what the card network answered.
 *
 * Sandbox only. The trial shops are made up; the cards, the payments and the renewal attempts are real Miden sandbox
 * calls. No real money moves.
 *
 * Two SANDBOX SHORTCUTS a real integration would not need:
 *   - the trial shops here never see a card number, so to play "the shop tries to renew" the demo looks up which
 *     one-time card paid each signup in the service's own Postgres (app_one_time_card) and asks Miden's simulator to
 *     charge that card. A real shop would just charge the card number it kept.
 *   - the renewal charge is Miden's sandbox simulator (POST /api/v1/mock/authorization), not a real card network.
 *
 * Env: AGENT_CARDS_URL, TRIAL_GUARD_AGENT_TOKEN, TRIAL_GUARD_USER_ID (from setup.ts, in .env.trial-guard),
 * MIDEN_CLIENT_ID, MIDEN_CLIENT_SECRET, MIDEN_UNIQUE_KEY (MIDEN_BASE_URL / MIDEN_TOKEN_URL default to the sandbox),
 * ANTHROPIC_API_KEY (unless TRIAL_GUARD_SCRIPTED=1), optional DATABASE_URL, PORT (8791), TRIAL_GUARD_MODEL.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import { CardLifecycle, MidenApiError, MidenBusinessError, MidenClient, configFromEnv } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} in the environment (see examples/trial-guard/README.md)`);
  return v;
};
const PORT = Number(process.env.PORT ?? 8791);
const HOST = "127.0.0.1";
const MODEL = process.env.TRIAL_GUARD_MODEL ?? "claude-opus-5-5";
const CARDS_URL = env("AGENT_CARDS_URL").replace(/\/$/, "");
const CARDS_TOKEN = env("TRIAL_GUARD_AGENT_TOKEN");
const USER_ID = env("TRIAL_GUARD_USER_ID");
const SCRIPTED = process.env.TRIAL_GUARD_SCRIPTED === "1";
if (!SCRIPTED) env("ANTHROPIC_API_KEY");

process.env.MIDEN_BASE_URL ??= "https://sandbox-api.midencards.io/miden";
process.env.MIDEN_TOKEN_URL ??= "https://sandbox-identityserver.midencards.io/connect/token";
if (!/sandbox/.test(process.env.MIDEN_BASE_URL)) throw new Error("this demo is sandbox-only: MIDEN_BASE_URL must be the Miden sandbox");
const lifecycle = new CardLifecycle(new MidenClient(configFromEnv()));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost/agent_cards", max: 2 });
const anthropic = SCRIPTED ? undefined : new Anthropic();
const PAGE = readFileSync(join(here, "index.html"), "utf8");

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const TRIAL_DAYS = 7;
/** Miden puts at least $1 on a one-time card, so the card check is $1: the card then holds nothing more. */
const CARD_CHECK_CENTS = 100;

// ---------------------------------------------------------------- the made-up trial shops

const TRIALS = [
  { id: "pixelforge", name: "Pixelforge Pro", what: "Design tool with AI image fill", renewalCents: 1499, mcc: "5734" },
  { id: "lumen", name: "Lumen Notes AI", what: "Notes app that writes your meeting summaries", renewalCents: 999, mcc: "5734" },
  { id: "streamly", name: "Streamly Plus", what: "Ad-free video streaming", renewalCents: 1299, mcc: "4899" },
] as const;
type TrialId = (typeof TRIALS)[number]["id"];
const trialOf = (id: string) => TRIALS.find((t) => t.id === id);

interface Renewal { status: "attempting" | "approved" | "declined" | "error"; message: string; at: string }
interface TrialState {
  status: "starting" | "active" | "failed";
  spendId?: string;
  /** The one-time card that paid the card check (null: paid some other way, never charged again by this demo). */
  cardId?: string | null;
  reason?: string;
  startedAt: string;
  renewal?: Renewal;
}
interface State { runId: string; day: number; trials: Partial<Record<TrialId, TrialState>> }

const stateFile = join(here, "../../.run/trial-guard.json");
const fresh = (): State => ({ runId: randomBytes(4).toString("hex"), day: 0, trials: {} });
let state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : fresh();
const save = () => {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
};

// ---------------------------------------------------------------- Agent Cards (the agent's own key)

async function cards(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${CARDS_URL}/agent/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${CARDS_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? j?.message ?? `Agent Cards ${r.status}`);
  return j;
}

/** SANDBOX SHORTCUT (see the header): which one-time card paid this spend, only ever for the demo's own user. */
async function oneTimeCardFor(spendId: string): Promise<string | null> {
  const r = await db.query<{ card_id: string | null }>(
    "SELECT card_id FROM app_one_time_card WHERE spend_id = $1 AND user_id = $2 AND status = 'ready'",
    [spendId, USER_ID],
  );
  return r.rows[0]?.card_id ?? null;
}

const inFlight = new Set<TrialId>();
async function startTrial(id: string): Promise<unknown> {
  const t = trialOf(id);
  if (!t) throw new Error(`no trial called ${id}; use list_trials`);
  const have = state.trials[t.id];
  if (have && have.status !== "failed") return { trial: t.name, alreadyStarted: true, ...view(t.id) };
  if (inFlight.has(t.id)) throw new Error(`${t.name} is already being signed up`);
  inFlight.add(t.id);
  state.trials[t.id] = { status: "starting", startedAt: new Date().toISOString() };
  save();
  try {
    // One key per trial per demo run: asking twice can never pay twice.
    const spend = await cards("POST", "/pay", {
      amountCents: CARD_CHECK_CENTS, merchant: `${t.name} (trial card check)`, mcc: t.mcc, idempotencyKey: `trial-${state.runId}-${t.id}`,
    });
    if (spend.status !== "approved") {
      state.trials[t.id] = { status: "failed", spendId: spend.spendId, reason: spend.reason ?? spend.status, startedAt: state.trials[t.id]!.startedAt };
    } else {
      const cardId = await oneTimeCardFor(spend.spendId);
      state.trials[t.id] = { status: "active", spendId: spend.spendId, cardId, startedAt: state.trials[t.id]!.startedAt };
    }
  } catch (e) {
    state.trials[t.id] = { status: "failed", reason: e instanceof Error ? e.message : String(e), startedAt: state.trials[t.id]!.startedAt };
  } finally {
    inFlight.delete(t.id);
    save();
  }
  return { trial: t.name, ...view(t.id) };
}

/** Renewal day: every active trial's shop tries to bill its monthly price, once, on the card it was given. */
async function renewalDay(): Promise<void> {
  state.day = TRIAL_DAYS + 1;
  save();
  for (const t of TRIALS) {
    const s = state.trials[t.id];
    if (!s || s.status !== "active" || s.renewal) continue;
    if (!s.cardId) {
      s.renewal = { status: "error", message: "This trial was not paid with a one-time card, so the demo does not charge it again.", at: new Date().toISOString() };
      save();
      continue;
    }
    // Recorded before the call: the simulator is not idempotent, so a crash here is never retried.
    s.renewal = { status: "attempting", message: "", at: new Date().toISOString() };
    save();
    try {
      await lifecycle.simulateAuthorization({
        cardId: s.cardId, amountDollars: t.renewalCents / 100, mcc: t.mcc, merchantName: `${t.name} monthly`,
        mid: String(Date.now()).slice(-15),
      });
      s.renewal = { status: "approved", message: `${t.name} charged ${usd(t.renewalCents)}.`, at: new Date().toISOString() };
    } catch (e) {
      // The same test the service uses: Miden said no (a business refusal or a 4xx) is a decline; a timeout, a 5xx or
      // a 429 is "we don't know", shown as such and never retried.
      const declined = e instanceof MidenBusinessError || (e instanceof MidenApiError && e.status >= 400 && e.status < 500 && e.status !== 429);
      s.renewal = { status: declined ? "declined" : "error", message: midenText(e), at: new Date().toISOString() };
    }
    save();
  }
}

/** Miden's own words for a refusal (responseCode + responseMessage), never the raw body. */
function midenText(e: unknown): string {
  if (e instanceof MidenApiError) {
    try {
      const b = JSON.parse(e.body) as { responseMessage?: string; message?: string; responseCode?: string };
      return `${b.responseCode ? b.responseCode + " " : ""}${b.responseMessage ?? b.message ?? `HTTP ${e.status}`}`;
    } catch {
      return `HTTP ${e.status}`;
    }
  }
  return (e instanceof Error ? e.message : String(e)).replace(/^Miden simulated authorization failed: /, "");
}

function view(id: TrialId) {
  const t = trialOf(id)!;
  const s = state.trials[id];
  return {
    id, name: t.name, what: t.what, cardCheck: usd(CARD_CHECK_CENTS), renewsAt: `${usd(t.renewalCents)}/month after ${TRIAL_DAYS} days`,
    status: s?.status ?? "not_started",
    ...(s?.reason ? { reason: s.reason } : {}),
    ...(s?.cardId ? { card: `one-time card …${s.cardId.slice(-6)}` } : s?.status === "active" ? { card: "not a one-time card" } : {}),
    ...(s?.renewal ? { renewal: s.renewal } : {}),
  };
}

// ---------------------------------------------------------------- the agent

const SYSTEM = `You are the agent in Trial Guard, an Agent Cards demo. You sign people up for free trials so they can never be billed after the trial ends.

How it works: you hold an Agent Card. Your owner is in privacy mode, so every payment you make uses a fresh one-time virtual card that holds exactly the payment amount and works for one charge. Each trial asks for a ${usd(CARD_CHECK_CENTS)} card check at signup; you pay that, and that card is then used up. When the trial ends and the shop tries to bill the monthly price, the card it kept has no money and no charges left.

Tools:
- list_trials: the trials on offer, their monthly price after the trial, and what you have already started.
- start_trial: sign up for one trial (pays its ${usd(CARD_CHECK_CENTS)} card check with a new one-time card). Takes about 10 to 30 seconds.
- get_wallet: your balance and limits.

Rules:
- This is the Agent Cards sandbox: the trial shops are made up, the cards and payments are Miden sandbox ones, no real money moves. Say so if asked.
- Only start trials the person clearly asked for. If they ask what is available, list them and ask which ones.
- Never invent a card, payment or result: use only what the tools return. If a signup fails, say why in plain words. A failure mentioning a maximum number of cards means the sandbox allows only three cards per customer (their own card plus two one-time cards), so at most two trials can be started; say that plainly.
- Your limits ($2 a payment, $5 a day) let you pay card checks but never a subscription price. Mention it if they ask you to pay for a full month.
- After signing up, tell them they can press "Skip to renewal day" on the right to watch each shop try to bill the card.
- Keep replies short and friendly. Amounts in dollars.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "list_trials", description: "The free trials on offer and what has been started.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "start_trial",
    description: `Sign up for one trial: pays its ${usd(CARD_CHECK_CENTS)} card check with a new one-time card.`,
    input_schema: { type: "object", properties: { trialId: { type: "string", enum: TRIALS.map((t) => t.id) } }, required: ["trialId"], additionalProperties: false },
    strict: true,
  },
  { name: "get_wallet", description: "Your Agent Card balance and limits.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
];

type Emit = (e: Record<string, unknown>) => void;
async function runTool(name: string, input: any): Promise<unknown> {
  if (name === "list_trials") return { trials: TRIALS.map((t) => view(t.id)), sandbox: true };
  if (name === "start_trial") return startTrial(String(input.trialId));
  if (name === "get_wallet") return cards("GET", "/wallet");
  throw new Error(`unknown tool ${name}`);
}

let history: Anthropic.Beta.BetaMessageParam[] = [];
let busy = false;

async function chatTurn(text: string, emit: Emit): Promise<void> {
  history.push({ role: "user", content: text });
  for (let step = 0; step < 10; step++) {
    const res = SCRIPTED ? scriptedReply() : await anthropic!.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: history,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    history.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) emit({ type: "text", text: b.text });
    if (res.stop_reason === "refusal") return emit({ type: "text", text: "Sorry, I can't help with that one." });
    if (res.stop_reason !== "tool_use") return;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")) {
      emit({ type: "tool", name: u.name, input: u.input });
      try {
        const out = await runTool(u.name, u.input);
        emit({ type: "tool_result", name: u.name, ok: true });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: u.name, ok: false, error: msg });
        results.push({ type: "tool_result", tool_use_id: u.id, content: msg, is_error: true });
      }
      emit({ type: "state" });
    }
    history.push({ role: "user", content: results });
  }
  emit({ type: "text", text: "(I stopped after too many steps; please try again.)" });
}

/** TRIAL_GUARD_SCRIPTED=1: starts each trial named in the last message (or the first two), then sums up. */
function scriptedReply(): { content: Anthropic.Beta.BetaContentBlock[]; stop_reason: string } {
  const lastUser = [...history].reverse().find((m) => typeof m.content === "string")?.content as string;
  const named = TRIALS.filter((t) => lastUser.toLowerCase().includes(t.name.split(" ")[0]!.toLowerCase()));
  const wanted = (named.length ? named : TRIALS.slice(0, 2)).map((t) => t.id);
  const next = wanted.find((id) => !state.trials[id] || state.trials[id]!.status === "starting");
  if (next) return { content: [{ type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: "start_trial", input: { trialId: next } }] as any, stop_reason: "tool_use" };
  const lines = wanted.map((id) => { const v = view(id); return `${v.name}: ${v.status}${v.reason ? ` (${v.reason})` : ""}`; });
  const anyActive = wanted.some((id) => state.trials[id]?.status === "active");
  const tail = anyActive ? ` Press "Skip to renewal day" to see what happens when they try to bill you.` : "";
  return { content: [{ type: "text", text: `(scripted) ${lines.join("; ")}.${tail}` }] as any, stop_reason: "end_turn" };
}

// ---------------------------------------------------------------- HTTP

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 20_000) throw new Error("too large");
  }
  return raw ? JSON.parse(raw) : {};
}
const json = (res: ServerResponse, code: number, v: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(v));
};

async function snapshot() {
  const wallet = await cards("GET", "/wallet").catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  return { day: state.day, trialDays: TRIAL_DAYS, trials: TRIALS.map((t) => view(t.id)), wallet, busy, scripted: SCRIPTED };
}

const server = createServer(async (req, res) => {
  try {
    // Same-origin only: a page on another site must not drive the agent or the renewal simulator.
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: "cross-origin" });
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && path === "/api/state") return json(res, 200, await snapshot());
    if (req.method === "POST" && path === "/api/chat") {
      const { text } = await body(req);
      if (typeof text !== "string" || !text.trim() || text.length > 2000) return json(res, 400, { error: "say something (under 2000 characters)" });
      if (busy) return json(res, 409, { error: "the agent is still working on your last message" });
      busy = true;
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      const emit: Emit = (e) => res.write(JSON.stringify(e) + "\n");
      try {
        await chatTurn(text.trim(), emit);
      } catch (e) {
        emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        busy = false;
        emit({ type: "done" });
        res.end();
      }
      return;
    }
    if (req.method === "POST" && path === "/api/renewal-day") {
      if (busy) return json(res, 409, { error: "the agent is still signing up; try again when it has finished" });
      busy = true;
      try {
        await renewalDay();
      } finally {
        busy = false;
      }
      return json(res, 200, await snapshot());
    }
    if (req.method === "POST" && path === "/api/reset") {
      if (busy) return json(res, 409, { error: "busy" });
      state = fresh();
      history = [];
      save();
      return json(res, 200, await snapshot());
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  }
});
server.listen(PORT, HOST, () => console.log(`trial guard on http://${HOST}:${PORT}${SCRIPTED ? " (scripted agent)" : ""}`));
