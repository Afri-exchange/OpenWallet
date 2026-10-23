// Signature check for developer webhooks, as in docs/developers.md. No dependencies.
import { createHmac, timingSafeEqual } from "node:crypto";

/** `x-agentcards-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. Check the RAW bytes, and reject a stale `t`. */
export function verify(secret: string, header: string | undefined, rawBody: string, nowMs = Date.now(), toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1 || v1.length !== 64 || !/^[0-9a-f]+$/i.test(v1)) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(want, Buffer.from(v1, "hex"));
}
