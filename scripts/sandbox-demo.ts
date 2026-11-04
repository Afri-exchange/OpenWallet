// End-to-end check of the running sandbox service (src/main.ts), driven exactly as a user and an agent would:
// sign up -> Card KYC (dummy data) -> card issued -> USDC deposit (simulated, or a real Base Sepolia one) ->
// card topped up on Miden -> agent created and funded -> agent pays over MCP -> limits, idempotency, revocation.
// MOVES SANDBOX MONEY. Prints no tokens.
// Run: node --import tsx scripts/sandbox-demo.ts [baseUrl=http://127.0.0.1:8787]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
let failures = 0;
const step = (s: string) => console.log(`\n== ${s}`);
const check = (ok: boolean, what: string) => {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}
async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2_000);
  }
}

const n = Date.now().toString().slice(-8);

step("1. Sign up");
const signup = await api("POST", "/api/signup", undefined, { email: `demo+${n}@example.com` });
check(signup.status === 201 && typeof signup.data.token === "string", `account created (${signup.data.userId})`);
const user = signup.data.token as string;
check((await api("GET", "/api/me", "uk_wrong")).status === 401, "a wrong user token is refused");

step("2. Card KYC (dummy sandbox identity)");
const kyc = await api("POST", "/api/me/kyc", user, {
  firstName: "Ada", lastName: `Demo${n.slice(-4)}`, dateOfBirth: "1990-01-31", idType: "PASSPORT", idNumber: `D${n}`,
  phone: `+23481${n}`, email: `demo+${n}@example.com`,
  idFrontImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  address: { address1: "1 Test Street", city: "Lagos", state: "Lagos", zipcode: "100001", country: "NG" },
});
check(kyc.status === 200, `KYC submitted: ${JSON.stringify(kyc.data)}`);

step("3. Card issued after approval");
const me = await until("card", async () => (await api("POST", "/api/me/refresh", user)).data, (d: any) => d.card?.deposit?.address);
check(me.kycStatus === "Approved", `KYC ${me.kycStatus}`);
check(/^[0-9a-f-]{36}$/.test(me.card.cardId), `card ${me.card.cardId}`);
check(/^0x[0-9a-f]{40}$/.test(me.card.deposit.address), `deposit address ${me.card.deposit.address} on ${me.card.deposit.chain}`);
const startBalance = Number(me.card.midenCardBalanceDollars);
console.log(`   Miden card balance at issue: $${startBalance}`);

step("4. Deposit $25 USDC (simulated) and wait for the Miden top-up");
check((await api("POST", "/api/me/simulate-deposit", user, { amountCents: 2_500 })).status === 202, "deposit credited");
const funded = await until("card top-up", async () => (await api("GET", "/api/me", user)).data, (d: any) => d.card.fundings.some((f: any) => f.status !== "reserved") );
const f = funded.card.fundings[0];
check(f.status === "completed", `top-up ${f.status} (${f.detail ?? ""})`);
check(funded.card.balances.unallocatedOnCardCents === 2_500, `unallocated on card $${funded.card.balances.unallocatedOnCardCents / 100}`);
// Miden's balance read lags its own transaction list by tens of seconds: wait for it.
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.001;
const fundedMiden = await until("Miden balance after top-up", async () => (await api("GET", "/api/me", user)).data, (d: any) => near(d.card.midenCardBalanceDollars, startBalance + 25), 180_000).catch(() => funded);
check(near(fundedMiden.card.midenCardBalanceDollars, startBalance + 25), `Miden card balance $${fundedMiden.card.midenCardBalanceDollars} (was $${startBalance})`);

step("5. Hand over to an agent: $10 budget, $6/payment, $8/day");
const agent = await api("POST", "/api/me/agents", user, { name: "demo-agent", perTransactionCents: 600, dailyCents: 800 });
check(agent.status === 201, `agent ${agent.data.agentId} created`);
const capped = await api("POST", "/api/me/agents", user, { name: "greedy", perTransactionCents: 10_000_000, dailyCents: 10_000_000 });
check(capped.status === 400 && /at most/.test(capped.data.error), `agent limits above the card's refused: ${capped.data.error}`);
check((await api("POST", `/api/me/agents/${agent.data.agentId}/fund`, user, { amountCents: 1_000 })).status === 200, "agent given $10");
check((await api("POST", `/api/me/agents/${agent.data.agentId}/fund`, user, { amountCents: 100_000 })).status === 409, "cannot give more than the card holds");

step("6. Agent connects over MCP");
const client = new Client({ name: "sandbox-demo-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${agent.data.token}` } } }));
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check(JSON.stringify(tools) === JSON.stringify(["get_wallet", "list_transactions", "pay"]), `tools: ${tools.join(", ")}`);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0]?.text ?? "";
  try { return { error: r.isError, value: JSON.parse(text) }; } catch { return { error: r.isError, value: text }; }
};
const w = await call("get_wallet");
check(w.value.balanceCents === 1_000 && w.value.limits.perTransactionCents === 600, `get_wallet: balance $${w.value.balanceCents / 100}, $${w.value.limits.perTransactionCents / 100}/payment`);

step("7. Agent pays");
const p1 = await call("pay", { amount_usd: 4.25, merchant: "Example Search API", mcc: "5734", idempotency_key: `demo-${n}-1` });
check(p1.value.status === "approved", `$4.25 to Example Search API: ${p1.value.status}${p1.value.reason ? " (" + p1.value.reason + ")" : ""}`);
const again = await call("pay", { amount_usd: 4.25, merchant: "Example Search API", mcc: "5734", idempotency_key: `demo-${n}-1` });
check(again.value.spendId === p1.value.spendId, "retry with the same key returns the same payment, no second charge");
const clash = await call("pay", { amount_usd: 5, merchant: "Other", idempotency_key: `demo-${n}-1` });
check(clash.error === true, `same key, different payment refused: ${clash.value}`);
const over = await call("pay", { amount_usd: 6.01, merchant: "Too Big Ltd", idempotency_key: `demo-${n}-2` });
check(over.value.status === "declined" && /per-transaction/.test(over.value.reason), `$6.01 over the per-payment limit: ${over.value.status} (${over.value.reason})`);
const daily = await call("pay", { amount_usd: 4, merchant: "Daily Cap Inc", idempotency_key: `demo-${n}-3` });
check(daily.value.status === "declined", `$4 more would pass the $8 daily limit: ${daily.value.status} (${daily.value.reason})`);
const bad = await call("pay", { amount_usd: 1.234, merchant: "Fractions" });
check(bad.error === true, "fractional cents refused");
const w2 = await call("get_wallet");
check(w2.value.balanceCents === 575 && w2.value.spentTodayCents === 425, `wallet now $${w2.value.balanceCents / 100}, spent today $${w2.value.spentTodayCents / 100}`);
const tx = await call("list_transactions", { limit: 10 });
check(Array.isArray(tx.value) && tx.value.length === 3, `list_transactions shows ${tx.value.length} attempts`);

step("8. Agent REST (the non-MCP way in)");
const rest = await api("POST", "/agent/v1/pay", agent.data.token, { amountCents: 150, merchant: "REST Coffee", mcc: "5814", idempotencyKey: `demo-${n}-rest` });
check(rest.data.status === "approved", `$1.50 over REST: ${rest.data.status}${rest.data.reason ? " (" + rest.data.reason + ")" : ""}`);

step("9. Miden saw the charges");
const after = await until("Miden balance to drop", async () => (await api("GET", "/api/me", user)).data, (d: any) => near(d.card.midenCardBalanceDollars, startBalance + 25 - 5.75), 180_000).catch(() => undefined);
const now = after ?? (await api("GET", "/api/me", user)).data;
check(near(now.card.midenCardBalanceDollars, startBalance + 25 - 5.75), `Miden card balance $${now.card.midenCardBalanceDollars} (expected $${(startBalance + 25 - 5.75).toFixed(2)})`);

step("10. Revoke");
check((await api("POST", `/api/me/agents/${agent.data.agentId}/revoke`, user)).status === 200, "agent revoked");
const dead = await api("GET", "/agent/v1/wallet", agent.data.token);
check(dead.status === 401, "revoked token is refused");
const final = (await api("GET", "/api/me", user)).data;
check(final.card.balances.unallocatedOnCardCents === 2_500 - 575, `agent's $4.25 returned; unallocated $${final.card.balances.unallocatedOnCardCents / 100}`);
await client.close();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures ? 1 : 0;
