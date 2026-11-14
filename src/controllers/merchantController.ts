import type { AgentCardsApp } from "../createApp.js";
import { limitOf, sendJson } from "../lib/http/respond.js";
import { requireCheckouts } from "../lib/utils/requireFeature.js";
import createControllerMethod from "./utils/createControllerMethod.js";

/* Merchant checkout, balance and payout API (`Authorization: Bearer mk_...`; signup is open). `req.callerId` is the merchant. */

export const signup = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await requireCheckouts(app).createMerchant(req.body));
  });

export const getProfile = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).merchantProfile(req.callerId!));
  });

export const rotateKey = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).rotateMerchantKey(req.callerId!));
  });

export const setPayoutAddress = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).setPayoutAddress(req.callerId!, req.body));
  });

export const getBalance = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).balance(req.callerId!));
  });

export const listPayouts = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).listPayouts(req.callerId!, limitOf(req.query)));
  });

export const requestPayout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await requireCheckouts(app).requestPayout(req.callerId!, req.body));
  });

export const createCheckout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await requireCheckouts(app).create(req.callerId!, req.body));
  });

export const listCheckouts = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).list(req.callerId!, limitOf(req.query)));
  });

export const getCheckout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).getForMerchant(req.callerId!, req.params.checkoutId!));
  });

export const cancelCheckout = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).cancel(req.callerId!, req.params.checkoutId!));
  });
