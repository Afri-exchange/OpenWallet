// Sandbox only: submits DUMMY business KYB, stores customerId/kycToken in gitignored .sandbox-state.json.
// Never prints credentials or kycToken. Run with MIDEN_* secrets in the environment.
import { writeFileSync } from "node:fs";
import { MidenClient, MidenApiError } from "../src/miden/client.js";

const baseUrl = "https://sandbox-api.midencards.io/miden";
const tokenUrl = "https://sandbox-identityserver.midencards.io/connect/token";
if (!baseUrl.includes("sandbox")) throw new Error("refusing: not sandbox");
const env = process.env;
const client = new MidenClient({
  baseUrl, tokenUrl,
  clientId: env.MIDEN_CLIENT_ID!, clientSecret: env.MIDEN_CLIENT_SECRET!, uniqueKey: env.MIDEN_UNIQUE_KEY!,
});

const clientReference = "test-platform-kyb-001";
try {
  const res = await client.request<Record<string, unknown>>("POST", "/api/v1/cards/kyc-submit", {
    customerType: "Business",
    phone: "+2348000000000",
    clientReference,
    businessKyc: {
      businessName: "Test Agent Cards Ltd (DUMMY)",
      registrationNumber: "RC0000000",
      businessAddress: { address1: "1 Test Street", city: "Lagos", state: "Lagos", zipcode: "100001", country: "NG" },
    },
  }, { reference: clientReference });
  const { kycToken, ...safe } = res;
  console.log(JSON.stringify(safe));
  writeFileSync(".sandbox-state.json", JSON.stringify({ platform: { customerId: res.customerId, kycToken, clientReference } }, null, 2));
} catch (e) {
  if (e instanceof MidenApiError) console.error(`failed: HTTP ${e.status} ${e.body.slice(0, 500)}`);
  else console.error(`failed: ${(e as Error).message}`);
  process.exitCode = 1;
}
