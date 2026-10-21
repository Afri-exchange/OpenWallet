// Sandbox only, read-only: probes USD account endpoints.
import { MidenClient, MidenApiError } from "../src/miden/client.js";
const c = new MidenClient({ baseUrl: "https://sandbox-api.midencards.io/miden", tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token", clientId: process.env.MIDEN_CLIENT_ID!, clientSecret: process.env.MIDEN_CLIENT_SECRET!, uniqueKey: process.env.MIDEN_UNIQUE_KEY! });
for (const p of process.argv.slice(2)) {
  try { const r = await c.request<any>("GET", p); console.log(p, "->", JSON.stringify(r).slice(0, 600)); }
  catch (e) { console.log(p, "->", e instanceof MidenApiError ? `HTTP ${e.status} ${e.body.slice(0, 200)}` : (e as Error).message); }
}
