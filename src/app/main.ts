// The agent-cards sandbox service: owner dashboard + agent REST + MCP, chain watcher, KYC poller, card funder.
// Run: node --import tsx src/app/main.ts   (needs MIDEN_CLIENT_ID, MIDEN_CLIENT_SECRET, MIDEN_UNIQUE_KEY in the environment)
import pg from "pg";
import { AgentWallets } from "../agents/wallets.js";
import { BASE_SEPOLIA_USDC, BaseUsdcWatcher, ETHEREUM_SEPOLIA_USDC, jsonRpc } from "../chain/base-usdc-watcher.js";
import { CircleClient, CircleDeposits } from "../chain/circle.js";
import { PgCursor, PgDepositAddresses } from "../chain/pg.js";
import { CardLifecycle } from "../cards/lifecycle.js";
import { CardService } from "../cards/service.js";
import { DEFAULT_TIERS } from "../cards/tiers.js";
import { MidenWalletFunding } from "../funding/miden-wallet.js";
import { Ledger } from "../ledger/ledger.js";
import { PgStore } from "../ledger/pg-store.js";
import { MidenClient } from "../miden/client.js";
import { CheckoutService } from "./checkout.js";
import { HdDepositWallet } from "./hd-wallet.js";
import { PayoutSender } from "./payouts.js";
import { UsdcPayoutRail } from "../chain/usdc-payout.js";
import { createAppServer } from "./server.js";
import { AppService } from "./service.js";
import { PgCardVault, vaultKeyFromEnv } from "../vault/vault.js";
import { SwapService, swapConfigFromEnv } from "../checkout-swap/swap.js";
import { RoutingFiller } from "../checkout-swap/router-filler.js";
import { DeveloperService } from "../developers/service.js";

const env = process.env;
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? "127.0.0.1";
const baseUrl = env.MIDEN_BASE_URL ?? "https://sandbox-api.midencards.io/miden";
const sandbox = new URL(baseUrl).host === "sandbox-api.midencards.io";
if (!sandbox) throw new Error("this service is sandbox-only: MIDEN_BASE_URL must be the Miden sandbox");
// Fake deposits only when asked for by name, and never against a real Miden host.
const simulatedDeposits = env.ALLOW_SIMULATED_DEPOSITS === "1";
if (simulatedDeposits && !sandbox) throw new Error("ALLOW_SIMULATED_DEPOSITS=1 is only allowed with the Miden sandbox");
const chain: string = "base-sepolia";

const pool = new pg.Pool({ connectionString: env.DATABASE_URL ?? "postgres://localhost/agent_cards", max: 10 });
const store = new PgStore(pool);
await store.migrate();

const ledger = new Ledger(undefined, store);
const miden = new MidenClient({
  baseUrl,
  tokenUrl: env.MIDEN_TOKEN_URL ?? "https://sandbox-identityserver.midencards.io/connect/token",
  clientId: need("MIDEN_CLIENT_ID"),
  clientSecret: need("MIDEN_CLIENT_SECRET"),
  uniqueKey: need("MIDEN_UNIQUE_KEY"),
});
const lifecycle = new CardLifecycle(miden);
const funding = new MidenWalletFunding(miden);
// Card vault: secureCardDetails are captured at issue time (Miden may only give the PAN once). Without
// CARD_VAULT_KEY cards still issue, but their details are not kept and they can never pay hosted checkouts.
const vault = env.CARD_VAULT_KEY ? new PgCardVault(pool, vaultKeyFromEnv()) : undefined;
if (!vault) log("WARNING: CARD_VAULT_KEY is not set: card details are NOT captured at issue, and checkout swaps are off");
const cards = new CardService(miden, funding, undefined, vault
  ? { vault, keys: { clientId: need("MIDEN_CLIENT_ID"), uniqueKey: need("MIDEN_UNIQUE_KEY") }, log }
  : undefined);
const wallets = new AgentWallets(ledger);
const addresses = new PgDepositAddresses(pool, chain);
const hd = HdDepositWallet.loadOrCreate(env.DEPOSIT_WALLET_FILE ?? ".sandbox-wallet.json");

// Circle deposit rail (sandbox): with CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET set, new cards get a Circle wallet
// (created on the fly) and inbound USDC arrives by webhook at POST /webhooks/circle. Without them: our own HD wallet.
if (!env.CIRCLE_API_KEY !== !env.CIRCLE_ENTITY_SECRET) throw new Error("set both CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET, or neither");
const circle = env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET
  ? new CircleClient({
      apiKey: env.CIRCLE_API_KEY, entitySecretHex: env.CIRCLE_ENTITY_SECRET,
      walletSetId: need("CIRCLE_WALLET_SET_ID"),
    })
  : undefined;
if (circle && !env.CIRCLE_API_KEY!.startsWith("TEST_API_KEY:")) throw new Error("this service is sandbox-only: CIRCLE_API_KEY must be a Circle TEST_API_KEY");
const circleDeposits = circle
  ? new CircleDeposits({
      circle, ledger, addresses,
      onCredited: (r) => log(`circle deposit: ${r.amountCents} cents on ${r.chain} for card ${r.cardId}`),
      onDust: (d) => log(`dust ${d.dustBase} base units on ${d.txHash} (not credited)`),
    })
  : undefined;
if (circle) log("Circle deposits on: new deposit addresses are Circle wallets (BASE-SEPOLIA); webhook at /webhooks/circle");

// The developer service needs the app, and the app reports events to it: tie the knot with a late binding.
let developersRef: DeveloperService | undefined;
const app = new AppService({
  pool, ledger, miden, lifecycle, cards, funding, wallets, addresses,
  deriveAddress: circle ? async (i) => (await circle.createDepositWallet(i)).address : (i) => hd.address(i), tiers: DEFAULT_TIERS, chain, sandbox, simulatedDeposits, log,
  ...(circle && env.CHAIN_WATCHER !== "1" ? { depositNetworks: [chain], depositRail: "circle" as const } : {}),
  onEvent: (userId, type, data) => developersRef?.onEvent(userId, type, data) ?? Promise.resolve(),
});
await app.restore();
// Sandbox: developers may point webhooks at http://localhost. Real deployments (not sandbox) never do.
const developers = new DeveloperService({ pool, app, allowLocalWebhooks: sandbox, publicUrl: env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`, log });
developersRef = developers;
// Merchant payouts: USDC on Base Sepolia from our payout account (m/44'/60'/1'/0/0). Fund it with test USDC
// (faucet.circle.com, Base Sepolia) and a little Base Sepolia ETH for gas.
const payoutAccount = hd.payoutAccount();
const checkout = new CheckoutService({
  pool, ledger, app, publicUrl: env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`, log,
  // Sandbox default 10 minutes so a demo can pay out the same day; the code default (and production) is 24 h.
  payoutAddressDelayMs: Number(env.PAYOUT_ADDRESS_DELAY_S ?? 600) * 1000,
  isOwnAddress: async (a) => a === payoutAccount.address.toLowerCase() || (await addresses.cardFor(a)) !== undefined,
});

// Chain watcher: Circle's test USDC on Base Sepolia, free public RPC.
const rpcUrl = env.BASE_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
const rpc = jsonRpc(rpcUrl);
const cursor = new PgCursor(pool, `${chain}:usdc`);
// faucet.circle.com opens on Ethereum Sepolia, so a user who misses the network picker pays there. One HD
// address is the same on every EVM chain, so we watch both and credit with a chain label of its own.
const networks = [
  { label: chain, token: BASE_SEPOLIA_USDC, rpc, cursor, confirmations: 5 },
  {
    label: "ethereum-sepolia", token: ETHEREUM_SEPOLIA_USDC, confirmations: 5,
    rpc: jsonRpc(env.ETHEREUM_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"),
    cursor: new PgCursor(pool, "ethereum-sepolia:usdc"),
  },
];
const stop = new AbortController();
// With Circle on, deposits come by webhook; the pollers only matter for older HD addresses (CHAIN_WATCHER=1).
for (const n of circle && env.CHAIN_WATCHER !== "1" ? [] : networks) {
  if ((await n.cursor.get()) === undefined) {
    const head = Number.parseInt((await n.rpc("eth_blockNumber", [])) as string, 16);
    await n.cursor.set(head - 20);
  }
  const watcher = new BaseUsdcWatcher({
    rpc: n.rpc, ledger, addresses, cursor: n.cursor, chain: n.label, token: n.token, maxRange: 500,
    // Testnet: 5 blocks so a sandbox deposit shows quickly. On Base mainnet use finality: "finalized":
    // a card top-up cannot be undone, so a reorged deposit would be a loss.
    confirmations: n.confirmations, finality: n.label === "base" ? "finalized" : "confirmations",
    onDust: (d) => log(`dust ${d.dustBase} base units on ${d.txHash}:${d.logIndex} (not credited)`),
  });
  let lastChainError = "";
  void watcher.run(stop.signal, {
    intervalMs: 4_000,
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== lastChainError) log(`chain watcher ${n.label}: ${msg}`);
      lastChainError = msg;
    },
  });
}

// Checkout swap: agents pay third-party hosted checkouts (Stripe) with the vaulted card. Off unless SWAP_ENABLED=1.
const swapConfig = swapConfigFromEnv();
if (swapConfig.enabled && !vault) throw new Error("SWAP_ENABLED=1 needs CARD_VAULT_KEY");
const swap = swapConfig.enabled && vault
  ? new SwapService({ pool, app, vault, filler: new RoutingFiller(), lifecycle, config: swapConfig, log })
  : undefined;
if (swap) log(`checkout swap on: hosts ${swapConfig.allowedHosts.join(", ")}, cap $${(swapConfig.maxAmountCents / 100).toFixed(2)}`);

const payouts = new PayoutSender({ pool, ledger, checkout, rail: new UsdcPayoutRail({ rpc, account: payoutAccount, confirmations: 5 }), log });
log(`payout account (Base Sepolia, fund with test USDC + ETH): ${payoutAccount.address}`);

// Background: finish KYC -> card for users in review, and move credited deposits onto cards.
async function background(): Promise<void> {
  for (const userId of await app.pendingKycUsers()) await app.refresh(userId).catch((e) => log(`kyc ${userId}: ${(e as Error).message}`));
  await app.fundPending().catch((e) => log(`funding: ${(e as Error).message}`));
  await app.reconcileSpends().catch((e) => log(`reconcile: ${(e as Error).message}`));
  // Not awaited: a slow webhook endpoint must not hold up reconcile and payouts (deliverDue is single-flight).
  void developers.deliverDue().catch((e) => log(`webhooks: ${(e as Error).message}`));
  await swap?.reconcile().catch((e) => log(`swap reconcile: ${(e as Error).message}`));
  await reconcileCircle().catch((e) => log(`circle reconcile: ${(e as Error).message}`));
  await checkout.sync().catch((e) => log(`checkouts: ${(e as Error).message}`));
  await payouts.tick().catch((e) => log(`payouts: ${(e as Error).message}`));
}
// Catch up on Circle deposits whose webhook never arrived (tunnel down, restart). At most once a minute.
let lastCircleSweep = 0;
async function reconcileCircle(): Promise<void> {
  if (!circleDeposits || Date.now() - lastCircleSweep < 60_000) return;
  lastCircleSweep = Date.now();
  const r = await circleDeposits.reconcile();
  if (r.credited > 0) log(`circle reconcile: credited ${r.credited} missed deposit(s)`);
}
const timer = setInterval(() => void background(), 5_000);

const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, ...(env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(",") : [])];
// Loopback on both IPv4 and IPv6: "localhost" may resolve to ::1, and another process holding the port
// there would silently receive our traffic (tokens, KYC). If either bind fails, refuse to run.
const hosts = HOST === "127.0.0.1" ? ["127.0.0.1", "::1"] : [HOST];
const servers = hosts.map((h) => {
  const s = createAppServer(app, { allowedHosts, checkout, swap, developers, circle: circleDeposits, webhookOnlyHosts: env.WEBHOOK_ONLY_HOSTS ? env.WEBHOOK_ONLY_HOSTS.split(",") : [], log });
  s.on("error", (e) => {
    log(`cannot listen on [${h}]:${PORT}: ${e.message}. Is something else on that port?`);
    process.exit(1);
  });
  s.listen(PORT, h);
  return s;
});
log(`agent-cards sandbox on http://127.0.0.1:${PORT} and http://localhost:${PORT} (chain ${chain}, rpc ${new URL(rpcUrl).host})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    stop.abort();
    clearInterval(timer);
    for (const s of servers) s.close();
    void pool.end().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
