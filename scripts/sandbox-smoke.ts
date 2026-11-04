// Read-only sandbox check: gets a token and lists wallet balances. Moves no money.
// Prints status and response codes only, never credentials or the token.
// Run: node --env-file=.env --import tsx scripts/sandbox-smoke.ts  (or export the MIDEN_* vars)
import { MidenClient, MidenApiError, configFromEnv } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";

const client = new MidenClient(configFromEnv());
try {
  const res = await client.request<{ isSuccessful: boolean; responseCode: string; data: { walletCurrency: string; walletAvailableBalance: number }[] }>(
    "GET",
    "/api/v1/wallet/balances",
  );
  console.log(`ok: isSuccessful=${res.isSuccessful} responseCode=${res.responseCode}`);
  for (const w of res.data ?? []) console.log(`  ${w.walletCurrency} available ${w.walletAvailableBalance}`);
} catch (e) {
  if (e instanceof MidenApiError) console.error(`failed: HTTP ${e.status}. On 401/403 check the IP whitelist (curl -s https://api.ipify.org).`);
  else console.error(`failed: ${(e as Error).message}`);
  process.exitCode = 1;
}
