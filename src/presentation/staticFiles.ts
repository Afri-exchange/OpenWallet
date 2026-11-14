import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "web");
/** Page routes and the only files served under /assets. Anything else is a 404, so no path can leave WEB. */
export const PAGES: Record<string, string> = { "/": "index.html", "/docs": "docs.html", "/docs/checkout": "docs-checkout.html","/app": "app.html", "/connect": "connect.html" };
export const ASSETS = new Set(["site.css", "site.js", "app.js", "docs.js", "home.js", "landing.js", "connect.js"]);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
// Scripts and styles only from ourselves; inline styles are allowed (generated markup uses style=""), inline scripts never.
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

interface Served { mtime: number; etag: string; type: string; raw: Buffer; br: Buffer; gz: Buffer }
const served = new Map<string, Served>();

/** Reads a web file once per change (checked by mtime), pre-compressed, so a request is a map lookup. */
function webFile(name: string): Served {
  const file = join(WEB, name);
  const mtime = statSync(file).mtimeMs;
  const hit = served.get(name);
  if (hit && hit.mtime === mtime) return hit;
  const raw = readFileSync(file);
  const next: Served = {
    mtime, raw, type: TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
    etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 22)}"`,
    br: brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }),
    gz: gzipSync(raw, { level: 9 }),
  };
  served.set(name, next);
  return next;
}

export function sendFile(req: IncomingMessage, res: ServerResponse, name: string, page: boolean): void {
  const f = webFile(name);
  const headers: Record<string, string> = {
    "content-type": f.type, etag: f.etag, vary: "accept-encoding",
    // Revalidate every time: a 304 costs one round trip and there are no hashed file names to cache forever.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  };
  if (page) { headers["content-security-policy"] = CSP; headers["x-frame-options"] = "DENY"; }
  if (req.headers["if-none-match"] === f.etag) { res.writeHead(304, headers); res.end(); return; }
  const accept = String(req.headers["accept-encoding"] ?? "");
  const [body, enc] = /\bbr\b/.test(accept) ? [f.br, "br"] : /\bgzip\b/.test(accept) ? [f.gz, "gzip"] : [f.raw, ""];
  if (enc) headers["content-encoding"] = enc;
  headers["content-length"] = String(body.length);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
