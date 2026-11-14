// Checkout swap end to end with NO real money: a Miden SANDBOX card, the vault, real headless Chromium on the local
// Stripe-like fixture page, and Miden's mock authorization standing in for the card network. Proves the card side of
// the swap (vault -> page fill -> card authorization -> match by amount and time). The Stripe page side is proven
// separately by scripts/swap-rehearsal.ts --url <Stripe TEST link>.
//
//   tsx scripts/swap-sandbox-e2e.ts --card <sandbox cardId> [--amount 1.00] [--headed]
//
// Vault: with DATABASE_URL + CARD_VAULT_KEY it reads the Postgres vault (cards captured by card-capture-check.ts
// --persist). Otherwise it captures the card's details into a throwaway in-memory vault through Miden's full-PAN
// endpoint (Kai's CardService.captureDetails). Prints last four only. Sandbox host only: refuses anything else.
import { createDatabase } from "../src/db/client.js";
import { createCardVaultRepository } from "../src/db/repositories/createCardVaultRepository.js";
import pg from "pg";
import { CardLifecycle, type CardTransaction } from "../src/adapters/virtualCards/CardLifecycle.js";
import { CardService } from "../src/adapters/virtualCards/CardService.js";
import { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { MemoryCardVault, SealedCardVault, vaultKeyFromEnv, type CardDetails, type CardVault } from "../src/adapters/cardVault/CardVault.js";
import { PlaywrightFiller } from "../src/adapters/checkoutFillers/PlaywrightFiller.js";
import { startCheckoutFixture } from "../src/adapters/checkoutFillers/fixtures/stripeFixture.js";
import { scrub } from "../src/adapters/checkoutFillers/CheckoutFiller.js";
import { parseCardTime } from "../src/lib/interactors/SwapInteractor.js";

const SANDBOX = "https://sandbox-api.midencards.io/miden";
const env = process.env;
const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};
const cardId = arg("--card");
if (!cardId) throw new Error("--card <sandbox cardId> is required (see .sandbox-state.json cards)");
const amountCents = Math.round(Number(arg("--amount") ?? "1") * 100);
if (!(amountCents > 0 && amountCents <= 1_000)) throw new Error("--amount must be between $0.01 and $10.00");
if (env.MIDEN_BASE_URL && new URL(env.MIDEN_BASE_URL).host !== new URL(SANDBOX).host) throw new Error("sandbox only: unset MIDEN_BASE_URL or point it at the sandbox");

const clientId = need("MIDEN_CLIENT_ID"), uniqueKey = need("MIDEN_UNIQUE_KEY");
const miden = new MidenClient({ baseUrl: SANDBOX, tokenUrl: "https://sandbox-identityserver.midencards.io/connect/token", clientId, clientSecret: need("MIDEN_CLIENT_SECRET"), uniqueKey });
const lifecycle = new CardLifecycle(miden);
const step = (ok: boolean, what: string) => console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);

let pool: pg.Pool | undefined;
let vault: CardVault;
if (env.DATABASE_URL && env.CARD_VAULT_KEY) {
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  vault = new SealedCardVault(createCardVaultRepository(createDatabase(pool)), vaultKeyFromEnv());
  console.log("vault: Postgres (DATABASE_URL)");
} else {
  vault = new MemoryCardVault();
  const cards = new CardService(miden, { fund: async () => ({ id: "n/a", status: "pending" }) }, undefined, { vault, keys: { clientId, uniqueKey } });
  console.log("vault: in-memory, capturing through Miden's full-PAN endpoint");
  step(await cards.captureDetails(cardId), "card details captured into the vault");
}

const fx = await startCheckoutFixture({
  // The "card network": a real Miden sandbox authorization on this card for the page's amount.
  onSubmit: async (s) => {
    await lifecycle.simulateAuthorization({ cardId, amountDollars: s.amountCents / 100, merchantName: "Swap E2E Fixture", mcc: "5734" });
  },
});
let failed = false;
try {
  const startedAt = Date.now();
  let card: CardDetails | null = await vault.reveal(cardId, `sandbox-e2e:${startedAt}`);
  step(Boolean(card), "card revealed from the vault (audited)");
  if (!card) throw new Error("no card details in the vault for this card");
  const last4 = card.pan.slice(-4);
  let r;
  try {
    r = await new PlaywrightFiller({ headless: !args.includes("--headed"), resultTimeoutMs: 60_000 }).fill({
      url: fx.url("success", amountCents), expectedAmountCents: amountCents, card, email: "sandbox-e2e@example.com",
    });
  } finally {
    scrub(card);
    card = null;
  }
  step(r.outcome === "succeeded", `page filled and paid (${r.outcome}${r.detail ? `: ${r.detail}` : ""})`);
  step(fx.submissions.at(-1)?.last4 === last4, `the page received card ****${last4}`);
  if (fx.lastSubmitError) console.log(`      card network said: ${fx.lastSubmitError}`);

  let txn: CardTransaction | undefined;
  const deadline = Date.now() + 120_000;
  while (!txn && Date.now() < deadline) {
    const list = await lifecycle.transactions(cardId, "Authorization", 50).catch(() => [] as CardTransaction[]);
    txn = list.find((t) => Math.round((t.transactionAmount ?? NaN) * 100) === amountCents && (parseCardTime(t.transactionTime) ?? 0) >= startedAt - 120_000);
    if (!txn) await new Promise((res) => setTimeout(res, 5_000));
  }
  step(Boolean(txn), txn ? `card shows the authorization: ${txn.transactionStatus}, MCC ${txn.merchantMcc ?? "?"}, at ${txn.transactionTime}` : "no matching authorization on the card within 2 minutes");
  failed = r.outcome !== "succeeded" || !txn;
} catch (e) {
  console.error((e as Error).message.slice(0, 200));
  failed = true;
} finally {
  await fx.close();
  await pool?.end();
}
console.log(failed ? "\nsandbox end to end: FAILED" : "\nsandbox end to end: PASSED");
process.exitCode = failed ? 1 : 0;
