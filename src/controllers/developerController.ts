import type { AgentCardsApp } from "../createApp.js";
import { limitOf, sendJson } from "../lib/http/respond.js";
import { requireDevelopers } from "../lib/utils/requireFeature.js";
import createControllerMethod from "./utils/createControllerMethod.js";

/* Developer API (`Authorization: Bearer dk_...`; signup is open). `req.callerId` is the developer. */

export const signup = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await requireDevelopers(app).signup(req.body));
  });

export const getProfile = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireDevelopers(app).profile(req.callerId!));
  });

export const rotateKey = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireDevelopers(app).rotateKey(req.callerId!));
  });

export const updateSettings = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireDevelopers(app).updateSettings(req.callerId!, req.body));
  });

export const listEvents = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireDevelopers(app).listEvents(req.callerId!, limitOf(req.query)));
  });

/** 201 when the user is new, 200 when the external id already had one. */
export const createUser = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const r = await requireDevelopers(app).createUser(req.callerId!, req.body);
    sendJson(res, r.created ? 201 : 200, r.user);
  });

export const listUsers = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireDevelopers(app).listUsers(req.callerId!, limitOf(req.query), req.query.get("externalId") ?? undefined));
  });

export const getUser = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireDevelopers(app).userView(req.callerId!, req.params.userId!));
  });

export const revokeSessions = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireDevelopers(app).revokeSessions(req.callerId!, req.params.userId!));
  });

export const createSession = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await requireDevelopers(app).createSession(req.callerId!, req.params.userId!, req.body.ttlSeconds));
  });

export const createAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await requireDevelopers(app).createAgent(req.callerId!, req.params.userId!, req.body));
  });

export const updateAgentLimits = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const { userId, agentId } = req.params as { userId: string; agentId: string };
    sendJson(res, 200, await requireDevelopers(app).updateAgentLimits(req.callerId!, userId, agentId, req.body));
  });

export const fundAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const { userId, agentId } = req.params as { userId: string; agentId: string };
    await requireDevelopers(app).fundAgent(req.callerId!, userId, agentId, req.body.amountCents, req.body.key);
    sendJson(res, 200, { ok: true });
  });

export const reclaimAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const { userId, agentId } = req.params as { userId: string; agentId: string };
    sendJson(res, 200, { reclaimedCents: await requireDevelopers(app).reclaimAgent(req.callerId!, userId, agentId, req.body.amountCents) });
  });

export const revokeAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const { userId, agentId } = req.params as { userId: string; agentId: string };
    await requireDevelopers(app).revokeAgent(req.callerId!, userId, agentId);
    sendJson(res, 200, { ok: true });
  });
