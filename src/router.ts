import type { AgentCardsApp } from "./createApp.js";
import { Router } from "./lib/http/Router.js";
import { authorizeAgent, authorizeDeveloper, authorizeMerchant, authorizeUser } from "./lib/middleware/auth.js";
import { jsonBody } from "./lib/middleware/bodyParser.js";
import { signup as developerSignup } from "./controllers/developerController.js";
import { signup as merchantSignup } from "./controllers/merchantController.js";
import { signup as ownerSignup } from "./controllers/ownerController.js";
import { agentRouter } from "./routes/agentRouter.js";
import { developerRouter } from "./routes/developerRouter.js";
import { mcpRouter } from "./routes/mcpRouter.js";
import { merchantRouter } from "./routes/merchantRouter.js";
import { ownerRouter } from "./routes/ownerRouter.js";
import { publicRouter } from "./routes/publicRouter.js";
import { webhooksRouter } from "./routes/webhooksRouter.js";

/**
 * HTTP surface (localhost only, see requestGuards):
 *   /  /docs  /app  /connect   site pages and /assets/... (presentation/web)
 *   /healthz                   health check
 *   /webhooks/circle           Circle deposit webhooks (signed)
 *   /pay/<id>  /v1/checkouts/<id>   a checkout's public page and JSON (the unguessable id is the access)
 *   /mcp                       MCP (streamable HTTP, stateless), `Authorization: Bearer ak_...`
 *   /agent/v1/...              agent REST API, `Authorization: Bearer ak_...`
 *   /merchant/v1/...           merchant API, `Authorization: Bearer mk_...` (POST /merchant/v1/signup is open)
 *   /developer/v1/...          developer API, `Authorization: Bearer dk_...` (POST /developer/v1/signup is open)
 *   /api/...                   owner API, `Authorization: Bearer uk_...` or a `us_` session (POST /api/signup is open)
 */
export const createRouter = (app: AgentCardsApp): Router => {
  const router = new Router();
  router.include(publicRouter(app));
  router.use("/webhooks/", webhooksRouter(app));
  router.include(mcpRouter(app));
  router.use("/agent/v1/", authorizeAgent(app), agentRouter(app));
  router.post("/merchant/v1/signup", jsonBody, merchantSignup(app));
  router.use("/merchant/v1/", authorizeMerchant(app), merchantRouter(app));
  router.post("/developer/v1/signup", jsonBody, developerSignup(app));
  router.use("/developer/v1/", authorizeDeveloper(app), developerRouter(app));
  router.post("/api/signup", jsonBody, ownerSignup(app));
  router.use("/api/me", authorizeUser(app), ownerRouter(app));
  return router;
};
