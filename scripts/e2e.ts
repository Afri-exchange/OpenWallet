// End-to-end against the Miden sandbox, polling instead of webhooks:
// KYC lookup -> issue card -> top up from the USD wallet -> simulated purchase -> poll balance and transactions.
// MOVES SANDBOX MONEY (a small top-up). Never prints the token, kycToken or card details.
// Run: node --import tsx scripts/e2e.ts <kycClientReference> [topUpDollars=5] [spendDollars=2]
// <kycClientReference> is the clientReference of an existing Card KYC submission for the cardholder.
import { CardLifecycle, poll } from "../src/cards/lifecycle.js";
import { CardService } from "../src/cards/service.js";
import { MidenWalletFunding } from "../src/funding/miden-wallet.js";
import { MidenApiError, MidenClient, configFromEnv } from "../src/miden/client.js";

const [kycRef, topUpArg = "5", spendArg = "2"] = process.argv.slice(2);
if (!kycRef) throw new Error("usage: e2e.ts <kycClientReference> [topUpDollars] [spendDollars]");
const topUpCents = Math.round(Number(topUpArg) * 100);
const spendCents = Math.round(Number(spendArg) * 100);
if (!(topUpCents > 0) || !(spendCents > 0) || spendCents > topUpCents) throw new Error("amounts must be positive and spend <= top-up");

const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);
const miden = new MidenClient(configFromEnv());
const life = new CardLifecycle(miden);
const cards = new CardService(miden, new MidenWalletFunding(miden));
const run = Date.now().toString(36);

try {
  step(1, `KYC status for clientReference ${kycRef}`);
  const kyc = await poll(() => life.kycStatus(kycRef), (k) => k.status === "Approved" || k.status === "Rejected", { timeoutMs: 300_000 });
  console.log(`    status=${kyc.status}`);
  if (kyc.status !== "Approved" || !kyc.customerId || !kyc.kycToken) throw new Error("KYC is not Approved: cannot issue a card");

  step(2, "Issue card");
  const policy = { perTransactionCents: spendCents * 2, dailyCents: topUpCents };
  const card = await cards.issue(`e2e-${run}`, policy, { customerId: kyc.customerId, kycToken: kyc.kycToken }, `e2e-card-${run}`);
  console.log(`    cardId=${card.id}`);

  step(3, `Top up $${topUpCents / 100} from the USD wallet`);
  const receipt = await cards.topUp(card, topUpCents, "USDC", `e2e-topup-${run}`);
  console.log(`    receipt ${receipt.id} ${receipt.status}`);
  if (receipt.status !== "confirmed") throw new Error("top-up not confirmed");
  const funded = await poll(() => life.cardBalance(card.id), (b) => b >= topUpCents / 100);
  console.log(`    card balance $${funded}`);

  step(4, `Local policy check for a $${spendCents / 100} purchase`);
  const verdict = cards.authorize(card, spendCents, "5734");
  console.log(`    ${JSON.stringify(verdict)}`);
  if (!verdict.ok) throw new Error("policy declined the purchase");

  step(5, "Simulated purchase (sandbox mock authorization)");
  const authId = await life.simulateAuthorization({ cardId: card.id, amountDollars: spendCents / 100 });
  console.log(`    authorizationId=${authId ?? "?"}`);
  const txns = await poll(() => life.transactions(card.id, "Authorization"), (t) => t.length > 0);
  for (const t of txns) console.log(`    ${t.transactionType} ${t.transactionStatus} $${t.transactionAmount} ${t.merchantName ?? ""}`);

  step(6, "Balance after spend");
  const after = await poll(() => life.cardBalance(card.id), (b) => b < funded, { timeoutMs: 60_000 });
  console.log(`    card balance $${after} (was $${funded})`);
  console.log("\nEnd to end OK");
} catch (e) {
  console.error(e instanceof MidenApiError ? `\nfailed: HTTP ${e.status} ${e.body.slice(0, 300)}` : `\nfailed: ${(e as Error).message}`);
  process.exitCode = 1;
}
