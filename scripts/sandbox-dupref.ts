// Sandbox only: same clientReference, fresh Reference header. Does Miden reject the second issuance?
import { readFileSync } from "node:fs";
import { MidenClient, MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
const c = new MidenClient({ baseUrl: "https://sandbox-api.midencards.io/miden", tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token", clientId: process.env.MIDEN_CLIENT_ID!, clientSecret: process.env.MIDEN_CLIENT_SECRET!, uniqueKey: process.env.MIDEN_UNIQUE_KEY! });
const s = JSON.parse(readFileSync(".sandbox-state.json", "utf8"));
const k = s.user1;
try {
  const r = await c.request<any>("POST", "/api/v2/cards/issue", { customerId: k.customerId, kycToken: k.kycToken, cardBrand: "Visa", initialBalance: 1, clientReference: s.cards[0].ref, walletCurrency: "USD", cardCurrency: "USD" }, { reference: `dup-${Date.now()}` });
  console.log("second issue ACCEPTED", r.isSuccessful, r.responseCode, r.data?.cardId === s.cards[0].cardId ? "same card" : "NEW card " + r.data?.cardId);
} catch (e) { console.log(e instanceof MidenApiError ? `rejected HTTP ${e.status} ${e.body.slice(0, 300)}` : (e as Error).message); }
