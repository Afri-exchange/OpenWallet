import type { Server } from "node:http";
import type { ServerConfig } from "./bootstrap.js";
import type { AgentCardsApp } from "./createApp.js";
import { createAppServer } from "./createHttpServer.js";

/**
 * Listens on the configured host. For 127.0.0.1 we bind IPv6 loopback too: "localhost" may resolve to ::1,
 * and another process holding the port there would silently receive our traffic (tokens, KYC). If either
 * bind fails, refuse to run.
 */
export function startAppServer(app: AgentCardsApp, config: ServerConfig, log: (m: string) => void): Server[] {
  const hosts = config.host === "127.0.0.1" ? ["127.0.0.1", "::1"] : [config.host];
  return hosts.map((h) => {
    const s = createAppServer(app, { allowedHosts: config.allowedHosts, webhookOnlyHosts: config.webhookOnlyHosts, log });
    s.on("error", (e) => {
      log(`cannot listen on [${h}]:${config.port}: ${e.message}. Is something else on that port?`);
      process.exit(1);
    });
    s.listen(config.port, h);
    return s;
  });
}
