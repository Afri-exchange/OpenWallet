// Sandbox only: spike for one-time (Lite) cards. Issues N Lite cards (swipeCount 1) under a saved customer, charges the
// first one twice with Miden's mock authorization, and prints what Miden says. Prints ids and statuses, never card data.
//   node --import tsx scripts/sandbox-lite.ts [who=platform] [n=4]
import { readFileSync } from "node:fs";
import { MidenClient, MidenApiError } from "../src/miden/client.js";
import { CardLifecycle } from "../src/cards/lifecycle.js";
import { referenceFor } from "../src/funding/miden-wallet.js";

const env = process.env;
const miden = new MidenClient({
  baseUrl: "https://sandbox-api.midencards.io/miden",
  tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token",
  clientId: env.MIDEN_CLIENT_ID!, clientSecret: env.MIDEN_CLIENT_SECRET!, uniqueKey: env.MIDEN_UNIQUE_KEY!,
});
const life = new CardLifecycle(miden);
const who = process.argv[2] ?? "platform";
const n = Number(process.argv[3] ?? 4);
const kyc = JSON.parse(readFileSync(".sandbox-state.json", "utf8"))[who];
const day = (months: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };

const ids: string[] = [];
for (let i = 1; i <= n; i++) {
  const ref = `lite-spike-${who}-${Date.now()}-${i}`;
  try {
    const res = await miden.request<any>("POST", "/api/v2/cards/issue-lite", {
      customerId: kyc.customerId, kycToken: kyc.kycToken, swipeCount: 1, cardBalance: 1,
      expirationDate: day(37), terminateDate: day(1), cardBrand: "Visa", walletCurrency: "USD", cardCurrency: "USD",
      clientReference: ref, contactlessPayment: false,
    }, { reference: referenceFor(`issue-lite:${ref}`), timeoutMs: 60_000 });
    const d = res.data ?? {};
    console.log(`lite ${i}: ${res.responseCode} ${res.responseMessage} id=${d.cardId} status=${d.status} bal=${d.availableBalance} keys=${Object.keys(d).join(",")}`);
    if (d.cardId) ids.push(d.cardId);
  } catch (e) {
    console.error(`lite ${i}: ${e instanceof MidenApiError ? `HTTP ${e.status} ${e.body.slice(0, 300)}` : (e as Error).message}`);
    break;
  }
}
const first = ids[0];
if (first) {
  for (const k of [1, 2]) {
    try { console.log(`charge ${k}: authorizationId=${await life.simulateAuthorization({ cardId: first, amountDollars: 0.5, mid: `lite${Date.now()}${k}` })}`); }
    catch (e) { console.log(`charge ${k}: ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, 4000));
  }
  await new Promise((r) => setTimeout(r, 20000));
  for (const t of await life.transactions(first)) console.log(`tx ${t.transactionType} ${t.transactionStatus} ${t.transactionAmount}`);
  console.log(`balance ${await life.cardBalance(first).catch((e) => (e as Error).message)}`);
  const det = await miden.request<any>("GET", `/api/v1/cards/details/${first}`).catch((e) => ({ err: String(e).slice(0, 200) }));
  console.log(`details status=${det.status ?? det.data?.status ?? JSON.stringify(det).slice(0, 200)}`);
}
