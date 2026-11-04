import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { authorizeAgent } from "../lib/middleware/auth.js";
import { jsonBody } from "../lib/middleware/bodyParser.js";
import { handleMcp, mcpMethodNotAllowed } from "../controllers/mcpController.js";

export const mcpRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.post("/mcp", authorizeAgent(app), jsonBody, handleMcp(app));
  router.all("/mcp", mcpMethodNotAllowed());
  return router;
};
