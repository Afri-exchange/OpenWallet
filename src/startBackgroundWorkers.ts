// Background work (the Afriex `startQueueWorkers.ts` role): chain watchers, and a 5-second tick that finishes
// KYC -> card, moves credited deposits onto cards, reconciles spends, delivers developer webhooks, reconciles
// hosted-checkout swaps and missed Circle deposits, syncs checkouts and sends payouts.
import { BaseUsdcWatcher } from "./adapters/deposits/BaseUsdcWatcher.js";
import type { AgentCardsApp } from "./createApp.js";
import type { AppParams } from "./domain/types/ContextTypes.js";

const errText = (e: unknown) => (e as Error).message;

export async function startBackgroundWorkers(
  params: Pick<AppParams, "ledger" | "addresses" | "watchedNetworks" | "log">,
  app: AgentCardsApp,
): Promise<{ stop(): void }> {
  const { log } = params;
  const stop = new AbortController();

  for (const n of params.watchedNetworks) {
    if ((await n.cursor.get()) === undefined) {
      const head = Number.parseInt((await n.rpc("eth_blockNumber", [])) as string, 16);
      await n.cursor.set(head - 20);
    }
    const watcher = new BaseUsdcWatcher({
      rpc: n.rpc, ledger: params.ledger, addresses: params.addresses, cursor: n.cursor, chain: n.label, token: n.token, maxRange: 500,
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

  // Catch up on Circle deposits whose webhook never arrived (tunnel down, restart). At most once a minute.
  let lastCircleSweep = 0;
  const circleIgnoredLogged = new Set<string>();
  async function reconcileCircle(): Promise<void> {
    if (!app.circleDeposits || Date.now() - lastCircleSweep < 60_000) return;
    lastCircleSweep = Date.now();
    const r = await app.circleDeposits.reconcile();
    if (r.credited > 0) log(`circle reconcile: credited ${r.credited} missed deposit(s)`);
    for (const i of r.ignored) {
      if (circleIgnoredLogged.has(i.id)) continue;
      circleIgnoredLogged.add(i.id);
      log(`circle reconcile: transfer ${i.id} to one of our addresses not credited (${i.reason})`);
    }
  }

  async function tick(): Promise<void> {
    const { cardholders } = app;
    for (const userId of await cardholders.pendingKycUsers()) await cardholders.refresh(userId).catch((e) => log(`kyc ${userId}: ${errText(e)}`));
    await cardholders.fundPending().catch((e) => log(`funding: ${errText(e)}`));
    await cardholders.reconcileSpends().catch((e) => log(`reconcile: ${errText(e)}`));
    // Not awaited: a slow webhook endpoint must not hold up reconcile and payouts (deliverDue is single-flight).
    if (app.developers) void app.developers.deliverDue().catch((e) => log(`webhooks: ${errText(e)}`));
    await app.swaps?.reconcile().catch((e) => log(`swap reconcile: ${errText(e)}`));
    await reconcileCircle().catch((e) => log(`circle reconcile: ${errText(e)}`));
    await app.checkouts?.sync().catch((e) => log(`checkouts: ${errText(e)}`));
    await app.payouts?.tick().catch((e) => log(`payouts: ${errText(e)}`));
  }
  const timer = setInterval(() => void tick(), 5_000);

  return {
    stop() {
      stop.abort();
      clearInterval(timer);
    },
  };
}
