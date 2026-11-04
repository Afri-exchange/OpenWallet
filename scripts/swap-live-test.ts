// The $10 live test of the checkout swap: ONE real payment, with ONE real Miden card, on ONE live Stripe link.
// Run it after scripts/card-capture-check.ts live ... --persist has put the card in the Postgres vault.
//
//   MIDEN_LIVE=1 MIDEN_BASE_URL=... MIDEN_TOKEN_URL=... MIDEN_LIVE_CLIENT_ID/_SECRET/_UNIQUE_KEY=... DATABASE_URL=... CARD_VAULT_KEY=... SWAP_RECEIPT_EMAIL=... \
//   tsx scripts/swap-live-test.ts --card <cardId> --url <live https://buy.stripe.com/... or checkout.stripe.com/c/pay/cs_live_...> \
//       --amount 10.00 [--mcc 5734] [--headed] [--confirm-live]
//
// Without --confirm-live it runs the preflight checklist only and stops. With it, it pays once and then watches the
// card for the Authorization (up to 5 minutes). It writes .live-test/<runId>.json (no card data: last four only) and
// keeps a journal in .live-test/journal.jsonl: a URL that already has a run in the journal is refused, so a crash or a
// re-run cannot pay twice. Delete that journal line by hand only after checking the card and Stripe.
//
// This does not go through the agent service (no agent, no ledger): it proves the card + vault + page fill + Miden
// reconcile chain end to end with the smallest moving parts.
import { createDatabase } from "../src/db/client.js";
import { createCardVaultRepository } from "../src/db/repositories/createCardVaultRepository.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { CardLifecycle, type CardTransaction } from "../src/adapters/virtualCards/CardLifecycle.js";
import { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { SealedCardVault, vaultKeyFromEnv, type CardDetails } from "../src/adapters/cardVault/CardVault.js";
import { PlaywrightFiller } from "../src/adapters/checkoutFillers/PlaywrightFiller.js";
import { scrub, type FillResult } from "../src/adapters/checkoutFillers/CheckoutFiller.js";
import { DEFAULT_SWAP_HOSTS, parseCardTime } from "../src/lib/interactors/SwapInteractor.js";

const LIVE_CAP_CENTS = 1_000; // not configurable: raising it is a code change and a review
const SANDBOX_HOST = "sandbox-api.midencards.io";
const DIR = ".live-test";
const JOURNAL = `${DIR}/journal.jsonl`;

const env = process.env;
const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const confirm = args.includes("--confirm-live");

type Check = { name: string; ok: boolean; note?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, note?: string) => (checks.push({ name, ok, note }), ok);

// ---------- preflight ----------
const cardId = arg("--card") ?? "";
const url = arg("--url") ?? "";
const dollars = Number(arg("--amount"));
const amountCents = Math.round(dollars * 100);
const mcc = arg("--mcc");
let parsed: URL | undefined;
try {
  parsed = new URL(url);
} catch {
  /* reported below */
}

check("--card given", Boolean(cardId));
check("--amount is a dollar amount, at most $10.00", Number.isFinite(dollars) && amountCents > 0 && amountCents <= LIVE_CAP_CENTS && Math.abs(dollars * 100 - amountCents) < 1e-6, `got ${arg("--amount")}`);
check("--url is https on a Stripe checkout host", parsed?.protocol === "https:" && DEFAULT_SWAP_HOSTS.includes(parsed.host), parsed?.host);
check("--url is LIVE mode (not cs_test_ / test_)", Boolean(parsed) && !/cs_test_|\/test_/.test(parsed!.pathname + parsed!.hash));
check("--mcc, if given, is 4 digits", mcc === undefined || /^\d{4}$/.test(mcc));
check("MIDEN_LIVE=1", env.MIDEN_LIVE === "1");
const baseOk = Boolean(env.MIDEN_BASE_URL && env.MIDEN_TOKEN_URL) && (() => {
  try {
    return new URL(env.MIDEN_BASE_URL!).host !== SANDBOX_HOST;
  } catch {
    return false;
  }
})();
check("MIDEN_BASE_URL / MIDEN_TOKEN_URL set, and not the sandbox", baseOk);
for (const k of ["MIDEN_LIVE_CLIENT_ID", "MIDEN_LIVE_CLIENT_SECRET", "MIDEN_LIVE_UNIQUE_KEY", "DATABASE_URL", "SWAP_RECEIPT_EMAIL"]) check(`${k} set`, Boolean(env[k]));
let key: Buffer | undefined;
try {
  key = vaultKeyFromEnv();
  check("CARD_VAULT_KEY valid (32 bytes)", true);
} catch (e) {
  check("CARD_VAULT_KEY valid (32 bytes)", false, (e as Error).message);
}
const journal: { url: string; runId: string; stage: string }[] = existsSync(JOURNAL)
  ? readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
check("no earlier run on this URL in .live-test/journal.jsonl", !journal.some((j) => j.url === url), "a second payment needs a new link or a manual journal edit");

const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 }) : undefined;
const vault = pool && key ? new SealedCardVault(createCardVaultRepository(createDatabase(pool)), key) : undefined;
const lifecycle = baseOk && env.MIDEN_LIVE_CLIENT_ID && env.MIDEN_LIVE_CLIENT_SECRET && env.MIDEN_LIVE_UNIQUE_KEY
  ? new CardLifecycle(new MidenClient({
    baseUrl: env.MIDEN_BASE_URL!, tokenUrl: env.MIDEN_TOKEN_URL!, clientId: env.MIDEN_LIVE_CLIENT_ID, clientSecret: env.MIDEN_LIVE_CLIENT_SECRET, uniqueKey: env.MIDEN_LIVE_UNIQUE_KEY,
  }))
  : undefined;

try {
  if (vault && cardId) check("card details are in the vault", await vault.has(cardId).catch(() => false));
  if (lifecycle && cardId && amountCents > 0) {
    const bal = await lifecycle.cardBalance(cardId).then((b) => b, (e: Error) => e);
    check("card balance covers the amount", typeof bal === "number" && Math.round(bal * 100) >= amountCents, typeof bal === "number" ? `$${bal.toFixed(2)}` : bal.message.slice(0, 120));
  }

  console.log("\nChecklist: checkout swap $10 live test");
  for (const c of checks) console.log(`  ${c.ok ? "[x]" : "[ ]"} ${c.name}${c.note && !c.ok ? `  (${c.note})` : ""}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed: nothing was paid.`);
    process.exitCode = 1;
  } else if (!confirm) {
    console.log("\nAll checks pass. Nothing was paid: re-run with --confirm-live to pay once.");
  } else {
    await pay();
  }
} finally {
  await pool?.end();
}

async function pay(): Promise<void> {
  const runId = `live_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomBytes(3).toString("hex")}`;
  mkdirSync(DIR, { recursive: true });
  const record = (stage: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(JOURNAL, `${JSON.stringify({ url, runId, cardId, amountCents, stage, at: new Date().toISOString(), ...extra })}\n`);
  // Journal first: if anything below crashes, this URL can never be paid again by accident.
  record("started");
  const startedAt = Date.now();
  let card: CardDetails | null = null;
  let last4 = "";
  let fill: FillResult;
  try {
    card = await vault!.reveal(cardId, `live-test:${runId}`);
    if (!card) throw new Error("card details disappeared from the vault");
    last4 = card.pan.slice(-4);
    fill = await new PlaywrightFiller({ headless: !args.includes("--headed"), resultTimeoutMs: 120_000 }).fill({
      url, expectedAmountCents: amountCents, card, email: env.SWAP_RECEIPT_EMAIL!,
    });
  } catch (e) {
    fill = { outcome: "error", submitted: false, detail: (e as Error).message.slice(0, 200) };
  } finally {
    scrub(card);
    card = null;
  }
  record("filled", { outcome: fill.outcome, submitted: fill.submitted });
  console.log(`\npage: ${fill.outcome}${fill.submitted ? " (submitted)" : ""}${fill.detail ? `: ${fill.detail}` : ""}`);

  // Watch the card for the Authorization unless nothing was submitted.
  let txn: CardTransaction | undefined;
  if (fill.submitted) {
    console.log("watching the card for the authorization (up to 5 minutes)...");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && !txn) {
      const list = await lifecycle!.transactions(cardId, "Authorization", 50).catch(() => [] as CardTransaction[]);
      txn = list.find((t) => Math.round((t.transactionAmount ?? NaN) * 100) === amountCents && (parseCardTime(t.transactionTime) ?? 0) >= startedAt - 120_000);
      if (!txn) await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  const verdict =
    fill.outcome === "succeeded" && txn && /^(approved|successful|settled)$/i.test(txn.transactionStatus ?? "") ? "PASS"
    : !fill.submitted ? "NOT PAID"
    : "CHECK BY HAND";
  const report = {
    runId, verdict, cardId, last4, amountCents, url, startedAt: new Date(startedAt).toISOString(),
    page: { outcome: fill.outcome, submitted: fill.submitted, detail: fill.detail ?? null, pageAmountCents: fill.pageAmountCents ?? null },
    card: txn ? {
      status: txn.transactionStatus, reference: txn.transactionReference ?? txn.id, merchantName: txn.merchantName, merchantMcc: txn.merchantMcc,
      declaredMcc: mcc ?? null, mccMatches: mcc ? mcc === txn.merchantMcc : null, authCode: txn.authCode, time: txn.transactionTime,
    } : null,
  };
  writeFileSync(`${DIR}/${runId}.json`, `${JSON.stringify(report, null, 2)}\n`);
  record("done", { verdict });
  console.log(`\n${verdict}: card ****${last4}, ${txn ? `authorization ${txn.transactionStatus} at ${txn.merchantName ?? "?"} (MCC ${txn.merchantMcc ?? "?"})` : "no authorization seen on the card"}`);
  console.log(`report: ${DIR}/${runId}.json`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
