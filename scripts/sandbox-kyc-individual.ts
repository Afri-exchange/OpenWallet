// Sandbox only: DUMMY individual Card KYC; saves to .sandbox-state.json under "user1".
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { MidenClient, MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";

const client = new MidenClient({
  baseUrl: "https://sandbox-api.midencards.io/miden", tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token",
  clientId: process.env.MIDEN_CLIENT_ID!, clientSecret: process.env.MIDEN_CLIENT_SECRET!, uniqueKey: process.env.MIDEN_UNIQUE_KEY!,
});
const ref = process.argv[2] ?? "test-user1-kyc-002";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
try {
  const res = await client.request<Record<string, unknown>>("POST", "/api/v1/cards/kyc-submit", {
    customerType: "Individual", phone: "+23480" + String(Date.now()).slice(-8), email: `test.person.${Date.now()}@example.com`, clientReference: ref,
    individualKyc: {
      firstName: "Test", lastName: "Person", dateOfBirth: "1990-01-01", idType: "PASSPORT", idNumber: "A" + String(Date.now()).slice(-8), idFrontImage: png,
      placeOfBirth: "Lagos", address: { address1: "1 Test Street", city: "Lagos", state: "Lagos", zipcode: "100001", country: "NG" },
    },
  }, { reference: ref });
  const { kycToken, ...safe } = res;
  console.log(JSON.stringify(safe));
  const state = existsSync(".sandbox-state.json") ? JSON.parse(readFileSync(".sandbox-state.json", "utf8")) : {};
  state[process.argv[3] ?? "user1"] = { customerId: res.customerId, kycToken, clientReference: ref };
  writeFileSync(".sandbox-state.json", JSON.stringify(state, null, 2));
} catch (e) {
  console.error(e instanceof MidenApiError ? `failed: HTTP ${e.status} ${e.body.slice(0, 500)}` : `failed: ${(e as Error).message}`);
  process.exitCode = 1;
}
