import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentCardsApp } from "../createApp.js";
import type { AgentPrincipal } from "../lib/interactors/CardholderInteractor.js";
import { sendJson } from "../lib/http/respond.js";
import { requireCheckouts, requireSwaps } from "../lib/utils/requireFeature.js";
import { buildAgentMcpServer, type AgentApi } from "../presentation/mcp/agentMcpServer.js";
import createControllerMethod from "./utils/createControllerMethod.js";

/** What an agent's MCP tools call: the same interactors as the agent REST API. */
export const agentApiFor = (app: AgentCardsApp, p: AgentPrincipal): AgentApi => ({
  wallet: () => app.cardholders.agentWallet(p),
  pay: (r) => app.cardholders.pay(p, r),
  transactions: (limit) => app.cardholders.agentTransactions(p, limit),
  getCheckout: (id) => requireCheckouts(app).getPublic(id),
  payCheckout: (id, maxAmountCents) => requireCheckouts(app).pay(p, id, { maxAmountCents }),
  payHostedCheckout: (r) => requireSwaps(app).pay(p, r),
  getHostedCheckoutPayment: (id) => requireSwaps(app).get(p, id),
});

/** MCP over streamable HTTP, stateless: one server and transport per request. */
export const handleMcp = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const server = buildAgentMcpServer(agentApiFor(app, req.agent!));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

export const mcpMethodNotAllowed = () =>
  createControllerMethod((_req, res) => {
    sendJson(res, 405, { error: "stateless MCP endpoint: POST only" });
  });
