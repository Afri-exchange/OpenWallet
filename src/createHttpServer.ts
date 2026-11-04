import { createServer, type Server, type ServerResponse } from "node:http";
import type { AgentCardsApp } from "./createApp.js";
import type { AppRequest } from "./domain/types/RequestTypes.js";
import { notFoundError, statusOf } from "./errors.js";
import { sendJson } from "./lib/http/respond.js";
import { requestGuards, type GuardOptions } from "./lib/middleware/requestGuards.js";
import { createRouter } from "./router.js";

export interface ServerOptions extends GuardOptions {
  log?: (m: string) => void;
}

/**
 * The HTTP server: request guards on every request, then the router (router.ts), then the error handler:
 * an AgentCardsError becomes its status and message; anything else is a logged 500 with no detail.
 */
export function createAppServer(app: AgentCardsApp, opts: ServerOptions): Server {
  const log = opts.log ?? app.log ?? (() => undefined);
  const guard = requestGuards(opts);
  const router = createRouter(app);

  async function handle(req: AppRequest, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    req.path = url.pathname;
    req.originalPath = url.pathname;
    req.query = url.searchParams;
    req.params = {};
    req.body = {};
    req.rawBody = "";
    await guard(req, res);
    if (!(await router.handle(req, res))) throw notFoundError("not found");
  }

  return createServer((req, res) => {
    handle(req as AppRequest, res).catch((e: unknown) => {
      const status = statusOf(e);
      if (status === 500) log(`500 ${req.method} ${req.url?.split("?")[0]}: ${e instanceof Error ? e.message : String(e)}`);
      if (res.headersSent) return void res.end();
      sendJson(res, status, { error: status === 500 ? "internal error" : (e as Error).message });
    });
  });
}
