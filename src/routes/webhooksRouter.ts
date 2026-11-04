import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { rawBody } from "../lib/middleware/bodyParser.js";
import { requireCircleDeposits } from "../lib/utils/requireFeature.js";
import { circleWebhook } from "../controllers/webhooksController.js";

export const webhooksRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.post(
    "/circle",
    () => void requireCircleDeposits(app), // 404 before reading the body when Circle is off
    rawBody,
    circleWebhook(app),
  );
  return router;
};
