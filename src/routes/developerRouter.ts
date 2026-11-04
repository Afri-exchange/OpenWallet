import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { jsonBody } from "../lib/middleware/bodyParser.js";
import {
  createAgent, createSession, createUser, fundAgent, getProfile, getUser, listEvents, listUsers, reclaimAgent, revokeAgent,
  revokeSessions, rotateKey, updateAgentLimits, updateSettings,
} from "../controllers/developerController.js";

const USER = "/users/:userId(u_[a-f0-9]+)";
const AGENT = `${USER}/agents/:agentId(a_[a-f0-9]+)`;

/** Mounted at /developer/v1/ behind `authorizeDeveloper` (signup is routed before the mount). */
export const developerRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.get("/me", getProfile(app));
  router.post("/key", rotateKey(app));
  router.post("/settings", jsonBody, updateSettings(app));
  router.get("/events", listEvents(app));
  router.post("/users", jsonBody, createUser(app));
  router.get("/users", listUsers(app));
  router.get(USER, getUser(app));
  router.delete(`${USER}/sessions`, revokeSessions(app));
  router.post(`${USER}/sessions`, jsonBody, createSession(app));
  router.post(`${USER}/agents`, jsonBody, createAgent(app));
  router.post(`${AGENT}/fund`, jsonBody, fundAgent(app));
  router.post(`${AGENT}/reclaim`, jsonBody, reclaimAgent(app));
  router.post(`${AGENT}/revoke`, jsonBody, revokeAgent(app));
  router.post(`${AGENT}/limits`, jsonBody, updateAgentLimits(app));
  return router;
};
