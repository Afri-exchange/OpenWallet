import type { AgentCardsApp } from "../createApp.js";
import { notFoundError } from "../errors.js";
import { sendJson } from "../lib/http/respond.js";
import { requireCheckouts } from "../lib/utils/requireFeature.js";
import { checkoutPage } from "../presentation/checkoutPage.js";
import { ASSETS, CSP, PAGES, sendFile } from "../presentation/staticFiles.js";
import createControllerMethod from "./utils/createControllerMethod.js";

/* Unauthenticated surface: site pages, their assets, the health check and a checkout's public page and JSON. */

/** A page route; "/docs/" is the same page as "/docs". */
export const getPage = () =>
  createControllerMethod((req, res) => {
    const key = req.path.length > 1 ? req.path.replace(/\/$/, "") : req.path;
    sendFile(req, res, PAGES[key]!, true);
  });

export const getAsset = () =>
  createControllerMethod((req, res) => {
    const name = req.params.name!;
    if (!ASSETS.has(name)) throw notFoundError("not found");
    sendFile(req, res, name, false);
  });

export const healthz = () =>
  createControllerMethod((_req, res) => {
    sendJson(res, 200, { ok: true });
  });

/** JSON view of a checkout (the unguessable id is the access). */
export const getCheckoutJson = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireCheckouts(app).getPublic(req.params.checkoutId!));
  });

/** The page a "Pay with Agent Card" link opens. */
export const getCheckoutPage = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const c = await requireCheckouts(app).getPublic(req.params.checkoutId!);
    const body = Buffer.from(checkoutPage(c));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store",
      "content-security-policy": CSP, "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
