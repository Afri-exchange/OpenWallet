// Demo 4: an agent over MCP, the way Claude Code or any MCP client connects: one ak_ token, streamable HTTP at /mcp.
// Lists the tools, reads the wallet and pays a small amount. Run 01-onboard.ts first. MOVES SANDBOX MONEY ($0.50).
// Run: node --env-file=examples/developer/.env.developer-demo --import tsx examples/developer/agent-mcp.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { baseUrl, fail, say } from "./lib.ts";

const token = process.env.DEMO_AGENT_TOKEN;
if (!token) fail("run 01-onboard.ts first");

const client = new Client({ name: "demo-agent", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

say(`tools: ${(await client.listTools()).tools.map((t) => t.name).join(", ")}`);
const text = (r: any) => (r.content as { text: string }[])[0]?.text ?? "";
say(`get_wallet -> ${text(await client.callTool({ name: "get_wallet", arguments: {} }))}`);
const paid = await client.callTool({ name: "pay", arguments: { amount_usd: 0.5, merchant: "MCP Demo Store", mcc: "5734", idempotency_key: `mcp-demo-${Date.now()}` } });
say(`pay $0.50 -> ${text(paid)}`);
await client.close();
