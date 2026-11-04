// Issues ONE card under a KYC'd customer and proves the secureCardDetails capture works on a real Miden response.
// Prints only the card id, the decrypt scheme and whether the vaulted PAN matches the issued firstSix/lastFour.
// The details go into an in-memory vault and are discarded at exit, unless --persist: then they are sealed into
// the Postgres vault (DATABASE_URL, CARD_VAULT_KEY) so the checkout swap can pay with this card.
//
//   Sandbox (default): tsx scripts/card-capture-check.ts user1          (customer from .sandbox-state.json, $1 card)
//   Live:              (secrets MIDEN_LIVE_CLIENT_ID, MIDEN_LIVE_CLIENT_SECRET, MIDEN_LIVE_UNIQUE_KEY)
//                      MIDEN_LIVE=1 MIDEN_BASE_URL=... MIDEN_TOKEN_URL=... MIDEN_LIVE_CUSTOMER_ID=... MIDEN_LIVE_KYC_TOKEN=... \
//                      tsx scripts/card-capture-check.ts live --amount 10 --confirm-live --persist
//   Existing card:     tsx scripts/card-capture-check.ts --capture <cardId> --persist   (sandbox; full-PAN recovery path, no new card)
//                      add --refresh to re-read name/billing address for a card already in the vault
//   Live spends real money ($amount is debited from the Miden wallet) and creates a real card: it needs --confirm-live.
import { readFileSync } from "node:fs";
import { CardService } from "../src/adapters/virtualCards/CardService.js";
import { MidenApiError, MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import pg from "pg";
import { PgLedgerStore } from "../src/db/repositories/PgLedgerStore.js";
import { MemoryCardVault, PgCardVault, vaultKeyFromEnv, type CardVault } from "../src/adapters/cardVault/CardVault.js";

const env = process.env;
const args = process.argv.slice(2);
const who = args[0] ?? "user1";
const live = env.MIDEN_LIVE === "1";
const amountAt = args.indexOf("--amount");
const amount = amountAt >= 0 ? Number(args[amountAt + 1]) : 1;
if (!Number.isFinite(amount)) throw new Error("--amount must be a number of dollars");
const SANDBOX = "https://sandbox-api.midencards.io/miden";

const baseUrl = live ? env.MIDEN_BASE_URL : SANDBOX;
const tokenUrl = live ? env.MIDEN_TOKEN_URL : "https://sandbox-identityserver.midencards.io/connect/token";
if (live) {
  if (!baseUrl || !tokenUrl || new URL(baseUrl).host === new URL(SANDBOX).host) throw new Error("MIDEN_LIVE=1 needs a live MIDEN_BASE_URL and MIDEN_TOKEN_URL");
  if (!args.includes("--confirm-live")) throw new Error("live issuance spends real money: pass --confirm-live");
  if (!(amount >= 1 && amount <= 10)) throw new Error("live test is capped at $10");
}
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};
// Live credentials live under their own names so the sandbox service keeps working alongside.
const p = live ? "MIDEN_LIVE_" : "MIDEN_";
const clientId = need(`${p}CLIENT_ID`), uniqueKey = need(`${p}UNIQUE_KEY`);
const kyc = live
  ? { customerId: need("MIDEN_LIVE_CUSTOMER_ID"), kycToken: need("MIDEN_LIVE_KYC_TOKEN") }
  : (JSON.parse(readFileSync(".sandbox-state.json", "utf8"))[who] as { customerId: string; kycToken: string });
if (!args.includes("--capture") && !kyc?.customerId) throw new Error(`no KYC'd customer "${who}" in .sandbox-state.json`);

const miden = new MidenClient({ baseUrl: baseUrl!, tokenUrl: tokenUrl!, clientId, clientSecret: need(`${p}CLIENT_SECRET`), uniqueKey });
const persist = args.includes("--persist");
let pool: pg.Pool | undefined;
let vault: CardVault = new MemoryCardVault();
if (persist) {
  pool = new pg.Pool({ connectionString: need("DATABASE_URL"), max: 2 });
  await new PgLedgerStore(pool).migrate();
  vault = new PgCardVault(pool, vaultKeyFromEnv());
}
const svc = new CardService(miden, { fund: async () => ({ id: "n/a", status: "pending" }) }, undefined, {
  vault, keys: { clientId, uniqueKey }, log: (m) => console.log(m),
});
const captureAt = args.indexOf("--capture");
if (captureAt >= 0) {
  const cardId = args[captureAt + 1];
  if (!cardId || live) throw new Error("--capture <cardId> is sandbox-only");
  try {
    const before = args.includes("--refresh") ? await vault.reveal(cardId, "capture-check:refresh") : null;
    const ok = await svc.captureDetails(cardId, { refreshLastFour: before?.pan.slice(-4) });
    const d = ok ? await vault.reveal(cardId, "capture-check") : null;
    console.log(`sandbox card ${cardId}: captured=${ok}${d ? `, ****${d.pan.slice(-4)}, exp ${String(d.expMonth).padStart(2, "0")}/${d.expYear}, name ${d.nameOnCard ? "yes" : "no"}, zip ${d.billingZip ? "yes" : "no"}, address ${d.billingAddress ? `yes (${d.billingAddress.country})` : "no"}` : ""}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await pool?.end();
  }
  process.exit();
}
const ref = `capture-check-${who}-${Date.now()}`;
try {
  const card = await svc.issue(`agent-${who}`, { perTransactionCents: amount * 100, dailyCents: amount * 100 }, kyc, ref, amount);
  console.log(`${live ? "LIVE" : "sandbox"} card ${card.id} (clientReference ${ref}): detailsCaptured=${card.detailsCaptured}`);
  const d = await vault.reveal(card.id, "capture-check");
  if (d) console.log(`vaulted: ****${d.pan.slice(-4)}, exp ${String(d.expMonth).padStart(2, "0")}/${d.expYear}, cvv ${d.cvv.length} digits`);
  process.exitCode = card.detailsCaptured ? 0 : 1;
} catch (e) {
  // MidenApiError.body may echo request data; print only its first part, never on a success path.
  if (e instanceof MidenApiError) console.error(`HTTP ${e.status} ${e.path}: ${e.body.slice(0, 300)}`);
  else console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
