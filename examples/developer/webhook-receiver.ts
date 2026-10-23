// Demo 5: a webhook receiver. Verifies the signature on the raw body, dedupes on the event id (delivery is at-least-once),
// answers 2xx fast, and handles each event type. Binds 127.0.0.1 only.
// Run:  WEBHOOK_SECRET=whsec_... node --import tsx examples/developer/webhook-receiver.ts      (PORT defaults to 4200)
// Then point your developer account at it (the secret is shown once, when you set the URL):
//   curl -s localhost:8787/developer/v1/settings -H "authorization: Bearer $DEVELOPER_KEY" -H 'content-type: application/json' \
//     -d '{"webhookUrl":"http://localhost:4200/hooks"}'
import { createServer } from "node:http";
import { verify } from "./webhook-verify.ts";

const secret = process.env.WEBHOOK_SECRET;
if (!secret) { console.error("set WEBHOOK_SECRET (the whsec_ value from POST /developer/v1/settings)"); process.exit(1); }
const seen = new Set<string>(); // a real receiver keeps these in its database, so a restart does not forget

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!verify(secret, req.headers["x-agentcards-signature"] as string | undefined, raw)) { res.writeHead(401).end(); return; }
    const id = String(req.headers["x-agentcards-event-id"]);
    if (seen.has(id)) { res.writeHead(200).end("duplicate"); return; } // a retry is the same event
    seen.add(id);
    const ev = JSON.parse(raw) as { type: string; externalId: string; data: Record<string, unknown> };
    switch (ev.type) {
      case "kyc.updated": console.log(`${ev.externalId}: KYC ${ev.data.kycStatus}`); break;
      case "card.issued": console.log(`${ev.externalId}: card ready, you can create agents now`); break;
      case "funding.completed": console.log(`${ev.externalId}: funded`, ev.data); break;
      case "spend.settled": console.log(`${ev.externalId}: ${ev.data.status} $${(Number(ev.data.amountCents) / 100).toFixed(2)} at ${ev.data.merchant}${ev.data.reason ? ` (${ev.data.reason})` : ""}`); break;
      default: console.log("ignoring", ev.type);
    }
    res.writeHead(200).end("ok");
  });
}).listen(Number(process.env.PORT ?? 4200), "127.0.0.1", () => console.log("webhook receiver on 127.0.0.1:" + (process.env.PORT ?? 4200)));
