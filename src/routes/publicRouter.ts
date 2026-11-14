import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { getAsset, getCheckoutJson, getCheckoutPage, getPage, healthz } from "../controllers/publicController.js";
import { PAGES } from "../presentation/staticFiles.js";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every page path, with or without a trailing slash. */
const PAGE_PATHS = new RegExp(`(?:${Object.keys(PAGES).map(escapeRe).join("|")})/?`);
const CHECKOUT_ID = ":checkoutId(cs_[a-f0-9]{32})";

export const publicRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.on(["GET", "HEAD"], PAGE_PATHS, getPage());
  router.on(["GET", "HEAD"], "/assets/:name", getAsset());
  router.get("/healthz", healthz());
  router.on(["GET", "HEAD"], `/pay/${CHECKOUT_ID}`, getCheckoutPage(app));
  router.on(["GET", "HEAD"], `/v1/checkouts/${CHECKOUT_ID}`, getCheckoutJson(app));
  return router;
};
