// The agent-cards sandbox service: owner dashboard + agent REST + MCP, chain watcher, KYC poller, card funder.
// Run: node --import tsx src/main.ts   (needs MIDEN_CLIENT_ID, MIDEN_CLIENT_SECRET, MIDEN_UNIQUE_KEY in the environment)
//
//   bootstrap.ts              env -> clients, repositories, adapters (AppParams)
//   createApp.ts              AppParams -> interactors (AgentCardsApp)
//   startBackgroundWorkers.ts chain watchers and the 5 s background tick
//   startAppServer.ts         HTTP: router.ts -> routes/ -> controllers/ -> lib/interactors/
import { bootstrapApplication, log } from "./bootstrap.js";
import { createApp } from "./createApp.js";
import { startAppServer } from "./startAppServer.js";
import { startBackgroundWorkers } from "./startBackgroundWorkers.js";

const { params, server: config } = await bootstrapApplication(process.env);
const app = createApp(params);
await app.cardholders.restore();
const workers = await startBackgroundWorkers(params, app);
const servers = startAppServer(app, config, log);
log(`agent-cards sandbox on http://127.0.0.1:${config.port} and http://localhost:${config.port} (chain ${params.chain}, rpc ${config.rpcHost})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    workers.stop();
    for (const s of servers) s.close();
    void params.pool.end().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
