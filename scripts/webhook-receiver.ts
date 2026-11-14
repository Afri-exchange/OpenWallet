// Sandbox webhook capture: accepts POSTs, writes each delivery (headers + raw body) to
// .webhook-captures/ (git-ignored) and logs whether x-signature verifies. Always answers 200.
// The webhook-hash header, and any header containing the hash raw or base64, is redacted before writing.
// Run: node --env-file=.env --import tsx scripts/webhook-receiver.ts   (PORT defaults to 8788; binds 127.0.0.1 only, a tunnel connects to it locally)
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { verifyWebhook } from "../src/lib/clients/cardIssuing/miden/webhookSignature.js";

const hash = process.env.MIDEN_WEBHOOK_HASH ?? "";
const dir = new URL("../.webhook-captures/", import.meta.url);
mkdirSync(dir, { recursive: true });
let n = 0;

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    // Miden sends base64(webhookHash) in a `webhook-hash` header on every request: that is the HMAC key, so never store it.
    const secretForms = hash ? [hash, Buffer.from(hash).toString("base64")] : [];
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k,
        k === "webhook-hash" || secretForms.some((s) => String(v).includes(s)) ? "<redacted: webhook hash>" : v,
      ]),
    );
    const sig = req.headers["x-signature"];
    const verified = verifyWebhook(raw, Array.isArray(sig) ? sig[0] : sig, hash);
    let eventType = "?";
    try { eventType = JSON.parse(raw).eventType ?? "?"; } catch {}
    const file = new URL(`${Date.now()}-${++n}.json`, dir);
    writeFileSync(file, JSON.stringify({ receivedAt: new Date().toISOString(), method: req.method, url: req.url, headers, verified, rawBody: raw }, null, 2));
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${eventType} x-signature=${sig ? "present" : "absent"} verified=${verified}`);
    // Customer-managed authorization callback: answer with a decision. SANDBOX ONLY: approves everything.
    const body = req.url?.startsWith("/miden/authorization")
      ? '{"responseCode":"000","responseReasonCode":"APPROVED","responseMessage":"Transaction approved"}'
      : '{"received":true}';
    res.writeHead(200, { "Content-Type": "application/json" }).end(body);
  });
}).listen(Number(process.env.PORT ?? 8788), "127.0.0.1", () => console.log(`webhook receiver on 127.0.0.1:${process.env.PORT ?? 8788}`));
