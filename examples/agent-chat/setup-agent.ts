/**
 * Makes the demo's own funded agent on the sandbox service and saves its keys to .env.agent-chat (repo root,
 * git-ignored): a test owner (dummy KYC), a simulated USDC deposit, and an agent with $10 per payment and $100 a day.
 * `--topup` adds another simulated deposit and moves it to the same agent.
 *
 *   node --import tsx examples/agent-chat/setup-agent.ts [--topup] [--url http://127.0.0.1:8787]
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const base = (urlIdx >= 0 ? args[urlIdx + 1]! : process.env.AGENT_CARDS_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const file = fileURLToPath(new URL("../../.env.agent-chat", import.meta.url));
const DEPOSIT = 10_000;
const fail = (s: string): never => { console.error(`ERROR: ${s}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: any }> {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function until(what: string, read: () => Promise<any>, done: (v: any) => boolean): Promise<any> {
  const end = Date.now() + 180_000;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what} (service log: .run/server.log)`);
    await sleep(2_000);
  }
}
const read = (): Record<string, string> => {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1], m![2]]));
};
const save = (k: Record<string, string>) => {
  writeFileSync(file, ["# Agent chat demo keys (sandbox only, git-ignored). Written by examples/agent-chat/setup-agent.ts.", ...Object.entries(k).map(([a, b]) => `${a}=${b}`)].join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
};

/** Simulated deposit onto the owner's card, then move it to the agent. */
async function fund(owner: string, agentId: string) {
  const before = (await api("GET", "/api/me", owner)).data.card.fundings.length;
  const dep = await api("POST", "/api/me/simulate-deposit", owner, { amountCents: DEPOSIT });
  if (dep.status !== 202) fail(`simulated deposit refused (${dep.status}: ${dep.data?.error ?? ""}); the service needs ALLOW_SIMULATED_DEPOSITS=1`);
  const me = await until("the card top-up", async () => (await api("GET", "/api/me", owner)).data,
    (d) => d.card.fundings.length > before && d.card.fundings.every((f: any) => f.status !== "reserved"));
  console.log(`  card top-up: ${me.card.fundings[0].status}`);
  const give = await api("POST", `/api/me/agents/${agentId}/fund`, owner, { amountCents: DEPOSIT - 500 });
  if (give.status !== 200) fail(`could not fund the agent: ${JSON.stringify(give.data)}`);
}

const keys = read();
if (args.includes("--topup")) {
  if (!keys.AGENT_CHAT_OWNER_TOKEN || !keys.AGENT_CHAT_AGENT_ID) fail("no demo agent yet; run without --topup first");
  await fund(keys.AGENT_CHAT_OWNER_TOKEN!, keys.AGENT_CHAT_AGENT_ID!);
} else {
  const n = Date.now().toString().slice(-8);
  const signup = await api("POST", "/api/signup", undefined, { email: `agent-chat+${n}@example.com` });
  if (signup.status !== 201) fail(`signup failed: ${JSON.stringify(signup.data)}`);
  const owner = signup.data.token as string;
  const kyc = await api("POST", "/api/me/kyc", owner, {
    firstName: "Demo", lastName: `Owner${n.slice(-4)}`, dateOfBirth: "1990-01-31", idType: "PASSPORT", idNumber: `D${n}`,
    phone: `+23482${n}`, email: `agent-chat+${n}@example.com`,
    idFrontImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    address: { address1: "1 Test Street", city: "Lagos", state: "Lagos", zipcode: "100001", country: "NG" },
  });
  if (kyc.status !== 200) fail(`KYC refused: ${JSON.stringify(kyc.data)}`);
  console.log("  owner signed up; waiting for the card");
  await until("the card", async () => (await api("POST", "/api/me/refresh", owner)).data, (d) => d.card?.deposit?.address);
  const agent = await api("POST", "/api/me/agents", owner, { name: "agent-chat-demo", perTransactionCents: 1_000, dailyCents: 10_000 });
  if (agent.status !== 201) fail(`could not create the agent: ${JSON.stringify(agent.data)}`);
  save({ AGENT_CARDS_URL: base, AGENT_CARDS_AGENT_TOKEN: agent.data.token, AGENT_CHAT_AGENT_ID: agent.data.agentId, AGENT_CHAT_OWNER_TOKEN: owner });
  await fund(owner, agent.data.agentId);
}
const w = await api("GET", "/agent/v1/wallet", read().AGENT_CARDS_AGENT_TOKEN);
console.log(`demo agent ready: balance $${(w.data.balanceCents / 100).toFixed(2)}, $${(w.data.limits.perTransactionCents / 100).toFixed(2)} per payment, $${(w.data.limits.dailyCents / 100).toFixed(2)} a day. Keys in .env.agent-chat`);
