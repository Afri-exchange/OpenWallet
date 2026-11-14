// Demo 2: spend limits. Run 01-onboard.ts first. Shows each way a payment is refused, then your server
// loosening the limit, the agent paying, and revoking the agent. MOVES SANDBOX MONEY (under $2).
// Run: node --env-file=examples/developer/.env.developer-demo --import tsx examples/developer/02-limits.ts
import { call, fail, ok, say } from "./lib.ts";

const { DEVELOPER_KEY: dk, DEMO_USER_ID: uid, DEMO_AGENT_ID: aid, DEMO_AGENT_TOKEN: ak } = process.env;
if (!dk || !uid || !aid || !ak) fail("run 01-onboard.ts first");
const base = `/developer/v1/users/${uid}/agents/${aid}`;
const pay = (cents: number, mcc: string, key: string) => call("POST", "/agent/v1/pay", ak, { amountCents: cents, merchant: "Demo Store", mcc, idempotencyKey: key });
const run = Date.now();

say("tighten the agent to $1.00 per payment, software MCC only (your server calls this with what your user chose)");
await ok("limits", call("POST", `${base}/limits`, dk, { perTransactionCents: 100, dailyCents: 500, allowedMccs: ["5734"] }));

let r = await pay(150, "5734", `over-${run}`);
say(`$1.50 (over the per-payment limit): ${r.data.status} - ${r.data.reason}`);
r = await pay(100, "5999", `mcc-${run}`);
say(`$1.00 at a retail MCC (not allowed):  ${r.data.status} - ${r.data.reason}`);

say("a limit above the user's card tier is refused, and the server says which one:");
const big = await call("POST", `${base}/limits`, dk, { perTransactionCents: 10_000_000, dailyCents: 10_000_000 });
say(`  ${big.status} ${JSON.stringify(big.data)}`);

r = await pay(100, "5734", `ok-${run}`);
say(`$1.00 at a software MCC (allowed):    ${r.data.status}`);
r = await pay(100, "5734", `ok-${run}`);
say(`same idempotency key again:           ${r.data.status} (the first result; nobody is charged twice)`);

say("take back what is left, then revoke the agent");
const back = await ok("reclaim", call("POST", `${base}/reclaim`, dk, { amountCents: 1 }));
say(`  reclaimed ${JSON.stringify(back)}`);
await ok("revoke", call("POST", `${base}/revoke`, dk, {}));
say(`  the old token now gets: ${(await call("GET", "/agent/v1/wallet", ak)).status} (expected 401)`);
