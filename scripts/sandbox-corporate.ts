// Sandbox only: tries POST /api/v1/cards/issue-corporate with dummy business details.
import { MidenClient, MidenApiError } from "../src/miden/client.js";
const c = new MidenClient({ baseUrl: "https://sandbox-api.midencards.io/miden", tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token", clientId: process.env.MIDEN_CLIENT_ID!, clientSecret: process.env.MIDEN_CLIENT_SECRET!, uniqueKey: process.env.MIDEN_UNIQUE_KEY! });
const ref = `test-corp-${Date.now()}`;
try {
  const r = await c.request<any>("POST", "/api/v1/cards/issue-corporate", {
    corporateCardName: "Test Agent Card (DUMMY)", corporateSpendCard: true, phone: "+2348000000000",
    address1: "1 Test Street", city: "Lagos", state: "Lagos", country: "NG", zipcode: "100001",
    email: "test.business@example.com", rcNumber: "RC0000000", initialBalance: 1, cardBrand: "Visa",
    clientReference: ref, walletCurrency: "USD",
  }, { reference: ref });
  console.log("ok", r.isSuccessful, r.responseCode, r.responseMessage, "cardId", r.data?.cardId);
} catch (e) { console.log(e instanceof MidenApiError ? `HTTP ${e.status} ${e.body.slice(0, 500)}` : (e as Error).message); }
