import { readFileSync } from "node:fs";
import { MidenClient } from "../src/miden/client.js";
import { CardLifecycle } from "../src/cards/lifecycle.js";
const c = new MidenClient({ baseUrl: "https://sandbox-api.midencards.io/miden", tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token", clientId: process.env.MIDEN_CLIENT_ID!, clientSecret: process.env.MIDEN_CLIENT_SECRET!, uniqueKey: process.env.MIDEN_UNIQUE_KEY! });
const s = JSON.parse(readFileSync(".sandbox-state.json","utf8"));
const l = new CardLifecycle(c);
for (const k of s.cards) console.log(k.cardId.slice(0,8), await l.cardBalance(k.cardId));
console.log((await c.request<any>("GET","/api/v1/wallet/balances")).data.map((w:any)=>w.walletCurrency+" "+w.walletAvailableBalance).join(", "));
