// Demo 3: privacy mode. Every payment uses a fresh one-time Lite card instead of the user's own card.
// MOVES SANDBOX MONEY. Read "Known limits" in docs/developers.md first: Miden caps a customer at 3 cards, Lite cards included,
// and a privacy user already holds their own, so only two payments can succeed until Miden lifts the cap. The third failing
// with Miden's message is expected, not a bug in this script.
// Run: node --import tsx examples/developer/03-privacy.ts
import { call, developerKey, kycAsUser, newAgent, newUser, ok, say, simulatedDeposit } from "./lib.ts";

const dk = await developerKey();
const { userId, externalId, session } = await newUser(dk, { privacyMode: true });
say(`user ${userId} created with privacyMode (fixed at creation; changing the default later only affects new users)`);
await kycAsUser(session, externalId);
await simulatedDeposit(session, 2_500);
const agent = await newAgent(dk, userId, { perTransactionCents: 1_000, dailyCents: 5_000 }, 2_000);

const view = await ok("user view", call("GET", `/developer/v1/users/${userId}`, dk));
say(`privacyMode=${view.privacyMode}`);

for (const cents of [100, 150, 200]) {
  const r = await call("POST", "/agent/v1/pay", agent.token, { amountCents: cents, merchant: "Private Store", mcc: "5734", idempotencyKey: `priv-${userId}-${cents}` });
  say(`$${(cents / 100).toFixed(2)} -> ${r.data.status}${r.data.reason ? ` (${r.data.reason})` : ""}`);
}
const after = await ok("wallet", call("GET", "/agent/v1/wallet", agent.token));
say(`agent balance after: ${JSON.stringify(after)}  (a declined or voided payment charges nothing)`);
say("Each approved payment used its own card number: two purchases cannot be linked by card. Payments under $1 make a $1 card (Miden's minimum).");
