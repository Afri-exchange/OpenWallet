// Sandbox only: issues N cards under the customer saved in .sandbox-state.json (key from argv[2], default "platform").
import { readFileSync, writeFileSync } from "node:fs";
import { MidenClient, MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { CardService } from "../src/adapters/virtualCards/CardService.js";

const baseUrl = "https://sandbox-api.midencards.io/miden";
const tokenUrl = "https://sandbox-identityserver.midencards.io/connect/token";
const env = process.env;
const client = new MidenClient({ baseUrl, tokenUrl, clientId: env.MIDEN_CLIENT_ID!, clientSecret: env.MIDEN_CLIENT_SECRET!, uniqueKey: env.MIDEN_UNIQUE_KEY! });
const svc = new CardService(client, { fund: async () => ({ id: "n/a", status: "pending" }) });
const who = process.argv[2] ?? "user1";
const n = Number(process.argv[3] ?? 2);
const state = JSON.parse(readFileSync(".sandbox-state.json", "utf8"));
const kyc = state[who];
state.cards ??= [];
for (let i = 1; i <= n; i++) {
  const ref = `test-card-${who}-${Date.now()}-${i}`;
  try {
    const card = await svc.issue(`agent-${who}-${i}`, { perTransactionCents: 1000, dailyCents: 2000 }, kyc, ref, 1);
    console.log(`card ${i}: ok id=${card.id}`);
    state.cards.push({ who, cardId: card.id, ref });
  } catch (e) {
    if (e instanceof MidenApiError) console.error(`card ${i}: HTTP ${e.status} ${e.body.slice(0, 400)}`);
    else console.error(`card ${i}: ${(e as Error).message}`);
    break;
  }
}
writeFileSync(".sandbox-state.json", JSON.stringify(state, null, 2));
