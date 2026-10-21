import { createHash, randomUUID } from "node:crypto";

/** 20-char nonce, sent as the Reference header and signed. */
export const newReference = (): string => randomUUID().replaceAll("-", "").slice(0, 20);

/**
 * base64 of the *hex* SHA-1 string, as in the PHP/C#/JS/Python samples.
 * Confirmed against the sandbox 2026-10-19: this is accepted, while base64 of
 * the raw digest gets 403 "Invalid Signature". `url` is the full URL including
 * the query string.
 */
export function sign(p: { method: string; url: string; reference: string; clientId: string; clientSecret: string }): string {
  const base = [p.method.toUpperCase(), encodeURIComponent(p.url), p.reference, p.clientId, p.clientSecret].join("&");
  return Buffer.from(createHash("sha1").update(base).digest("hex")).toString("base64");
}
