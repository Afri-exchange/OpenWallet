import type { AgentCardsApp } from "../../createApp.js";
import type { AppRequest, Handler } from "../../domain/types/RequestTypes.js";
import { unauthorizedError } from "../../errors.js";
import { requireCheckouts, requireDevelopers } from "../utils/requireFeature.js";

/** The bearer token, if the Authorization header is `Bearer <token>`. */
export function bearer(req: AppRequest): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return m?.[1];
}

/**
 * Owner API: the owner's token (uk_) or a developer-issued session (us_, short-lived). With `ownerTokenOnly`,
 * a session is refused (a session must not mint a permanent token). Sets `req.callerId` to the user id.
 */
export const authorizeUser = (app: AgentCardsApp, opts: { ownerTokenOnly?: boolean } = {}): Handler => async (req) => {
  const t = bearer(req);
  const id = t && t.startsWith("uk_") ? await app.cardholders.userByToken(t)
    : t && t.startsWith("us_") && !opts.ownerTokenOnly ? await app.cardholders.userBySession(t)
    : undefined;
  if (!id) throw unauthorizedError("missing or invalid user token");
  req.callerId = id;
};

/** Agent REST and MCP: an agent token (ak_). Sets `req.agent`. */
export const authorizeAgent = (app: AgentCardsApp): Handler => async (req) => {
  const t = bearer(req);
  const a = t && t.startsWith("ak_") ? await app.cardholders.agentByToken(t) : undefined;
  if (!a) throw unauthorizedError("missing, invalid or revoked agent token");
  req.agent = a;
};

/** Merchant API: a merchant secret key (mk_). Sets `req.callerId` to the merchant id. */
export const authorizeMerchant = (app: AgentCardsApp): Handler => async (req) => {
  const t = bearer(req);
  const id = t && t.startsWith("mk_") ? await requireCheckouts(app).merchantByKey(t) : undefined;
  if (!id) throw unauthorizedError("missing or invalid merchant secret key");
  req.callerId = id;
};

/** Developer API: a developer key (dk_). Sets `req.callerId` to the developer id. */
export const authorizeDeveloper = (app: AgentCardsApp): Handler => async (req) => {
  const t = bearer(req);
  const id = t && t.startsWith("dk_") ? await requireDevelopers(app).byKey(t) : undefined;
  if (!id) throw unauthorizedError("missing or invalid developer key");
  req.callerId = id;
};
