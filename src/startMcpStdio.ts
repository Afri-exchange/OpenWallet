// MCP over stdio for agents that launch tools as local processes (Claude Desktop, Claude Code, ...).
// It forwards to the running agent-cards server's agent REST API with the agent's token.
//   AGENT_CARDS_URL=http://127.0.0.1:8787 AGENT_CARDS_TOKEN=ak_... node --import tsx src/startMcpStdio.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildAgentMcpServer } from "./presentation/mcp/agentMcpServer.js";
import type { SpendView } from "./lib/interactors/CardholderInteractor.js";

const base = (process.env.AGENT_CARDS_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.AGENT_CARDS_TOKEN;
const { protocol, hostname } = new URL(base);
if (protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
  process.stderr.write(`refusing to send the agent token over plain http to ${hostname}: use https\n`);
  process.exit(1);
}
if (!token) {
  process.stderr.write("AGENT_CARDS_TOKEN is not set\n");
  process.exit(1);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

const server = buildAgentMcpServer({
  wallet: () => call("GET", "/agent/v1/wallet"),
  pay: (req) => call<SpendView>("POST", "/agent/v1/pay", req),
  transactions: (limit) => call<SpendView[]>("GET", `/agent/v1/transactions${limit ? `?limit=${limit}` : ""}`),
  getCheckout: (id) => call("GET", `/agent/v1/checkouts/${encodeURIComponent(id)}`),
  payCheckout: (id, maxAmountCents) => call("POST", `/agent/v1/checkouts/${encodeURIComponent(id)}/pay`, { maxAmountCents }),
  payHostedCheckout: (req) => call("POST", "/agent/v1/hosted-checkouts/pay", req),
  getHostedCheckoutPayment: (id) => call("GET", `/agent/v1/hosted-checkouts/${encodeURIComponent(id)}`),
});
await server.connect(new StdioServerTransport());
