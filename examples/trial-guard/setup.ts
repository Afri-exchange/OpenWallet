/**
 * Makes the demo's privacy-mode user and agent on the sandbox service, and saves the agent's key to .env.trial-guard
 * (repo root, git-ignored, mode 600, never printed). Sandbox only: a dummy KYC identity and a simulated USDC deposit.
 *
 *   node --import tsx examples/trial-guard/setup.ts
 *
 * The user is created with privacyMode, so every payment their agent makes is a fresh one-time card holding exactly
 * that amount. The agent may spend $2 per payment and $5 a day: enough for trial card checks, never a subscription.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baseUrl, call, developerKey, kycAsUser, newAgent, newUser, ok, say, simulatedDeposit } from "../developer/lib.ts";

const file = fileURLToPath(new URL("../../.env.trial-guard", import.meta.url));
const dk = await developerKey("Trial Guard demo");
const { userId, externalId, session } = await newUser(dk, { privacyMode: true });
say(`privacy-mode user ${userId} created; doing the sandbox KYC (dummy identity)`);
await kycAsUser(session, externalId);
await simulatedDeposit(session, 1_000);
const agent = await newAgent(dk, userId, { perTransactionCents: 200, dailyCents: 500 }, 500);
writeFileSync(file, [
  "# Trial Guard demo keys (sandbox only, git-ignored). Written by examples/trial-guard/setup.ts.",
  `AGENT_CARDS_URL=${baseUrl}`,
  `TRIAL_GUARD_AGENT_TOKEN=${agent.token}`,
  `TRIAL_GUARD_USER_ID=${userId}`,
].join("\n") + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
const w = await ok("wallet", call("GET", "/agent/v1/wallet", agent.token));
say(`agent ready: $${(w.balanceCents / 100).toFixed(2)} to spend, $${(w.limits.perTransactionCents / 100).toFixed(2)} per payment, $${(w.limits.dailyCents / 100).toFixed(2)} a day, privacy mode on. Keys in .env.trial-guard`);
