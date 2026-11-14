import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { jsonBody } from "../lib/middleware/bodyParser.js";
import {
  cancelCheckout, createCheckout, getBalance, getCheckout, getProfile, listCheckouts, listPayouts, requestPayout, rotateKey, setPayoutAddress,
} from "../controllers/merchantController.js";

const CHECKOUT_ID = ":checkoutId([A-Za-z0-9_]+)";

/** Mounted at /merchant/v1/ behind `authorizeMerchant` (signup is routed before the mount). */
export const merchantRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.get("/me", getProfile(app));
  router.post("/key", rotateKey(app));
  router.post("/payout-address", jsonBody, setPayoutAddress(app));
  router.get("/balance", getBalance(app));
  router.get("/payouts", listPayouts(app));
  router.post("/payouts", jsonBody, requestPayout(app));
  router.post("/checkouts", jsonBody, createCheckout(app));
  router.get("/checkouts", listCheckouts(app));
  router.get(`/checkouts/${CHECKOUT_ID}`, getCheckout(app));
  router.post(`/checkouts/${CHECKOUT_ID}/cancel`, cancelCheckout(app));
  return router;
};
