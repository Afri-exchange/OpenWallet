// Sandbox only: tops up the first saved card by $2.00 and re-sends an issue with a duplicate clientReference.
import { readFileSync } from "node:fs";
import { MidenClient, MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { MidenWalletFunding } from "../src/adapters/funding/MidenWalletFunding.js";
const client = new MidenClient({
  baseUrl: "https://sandbox-api.midencards.io/miden", tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token",
  clientId: process.env.MIDEN_CLIENT_ID!, clientSecret: process.env.MIDEN_CLIENT_SECRET!, uniqueKey: process.env.MIDEN_UNIQUE_KEY!,
});
const state = JSON.parse(readFileSync(".sandbox-state.json", "utf8"));
const bal = async () => (await client.request<any>("GET", "/api/v1/wallet/balances")).data.find((w: any) => w.walletCurrency === "USD").walletAvailableBalance;
const before = await bal();
try {
  const r = await new MidenWalletFunding(client).fund({ cardId: state.cards[0].cardId, amountCents: 200, asset: "USDC", idempotencyKey: `test-topup-${Date.now()}` });
  console.log("topup ok", JSON.stringify(r));
} catch (e) { console.error(e instanceof MidenApiError ? `topup HTTP ${e.status} ${e.body.slice(0, 400)}` : (e as Error).message); }
console.log(`USD wallet ${before} -> ${await bal()}`);
