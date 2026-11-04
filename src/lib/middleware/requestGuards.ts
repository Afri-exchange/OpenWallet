import type { Handler } from "../../domain/types/RequestTypes.js";
import { forbiddenError, misdirectedRequestError, notFoundError, unsupportedMediaTypeError } from "../../errors.js";

export interface GuardOptions {
  /** Host headers we answer to, e.g. "127.0.0.1:8787". */
  allowedHosts: string[];
  /** Public tunnel hosts: they may only reach the Circle webhook and the health check. */
  webhookOnlyHosts?: string[];
}

const WEBHOOK_ONLY_PATHS = new Set(["/webhooks/circle", "/healthz"]);

/**
 * Runs before any route, on every request:
 * - DNS-rebinding guard: a browser page on another site cannot reach us under its own hostname (421).
 * - Webhook-only hosts reach nothing but the webhook and the health check (404).
 * - Every POST must be `content-type: application/json`, and a browser Origin must be one of ours. Cross-site
 *   forms and text/plain fetches skip the CORS preflight; requiring JSON forces one, and a foreign Origin is
 *   refused outright.
 */
export function requestGuards(opts: GuardOptions): Handler {
  const allowed = new Set([...opts.allowedHosts, ...(opts.webhookOnlyHosts ?? [])].map((h) => h.toLowerCase()));
  const webhookOnly = new Set((opts.webhookOnlyHosts ?? []).map((h) => h.toLowerCase()));
  // https too: behind a TLS tunnel the browser sends https://<host>; the host itself must still be allowed.
  const allowedOrigins = new Set([...allowed].flatMap((h) => [`http://${h}`, `https://${h}`]));

  return (req) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowed.has(host)) throw misdirectedRequestError("unexpected Host header");
    if (webhookOnly.has(host) && !WEBHOOK_ONLY_PATHS.has(req.path)) throw notFoundError("not found");
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) throw forbiddenError("cross-origin request refused");
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw unsupportedMediaTypeError("content-type must be application/json");
    }
  };
}
