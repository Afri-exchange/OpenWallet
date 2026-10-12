import { createHash, randomUUID } from "node:crypto";

/**
 * The Miden docs are inconsistent: prose says base64(SHA-1 digest), but the
 * PHP/C#/JS/Python samples base64 the *hex* SHA-1 string. Default to the
 * samples; confirm against the sandbox and drop the unused mode.
 */
export type SignatureMode = "base64-of-hex" | "base64-of-digest";

/** 20-char nonce, sent as the Reference header and signed. */
export const newReference = (): string => randomUUID().replaceAll("-", "").slice(0, 20);

export function sign(
  p: { method: string; url: string; reference: string; clientId: string; clientSecret: string },
  mode: SignatureMode = "base64-of-hex",
): string {
  const base = [p.method.toUpperCase(), encodeURIComponent(p.url), p.reference, p.clientId, p.clientSecret].join("&");
  const sha = createHash("sha1").update(base);
  return mode === "base64-of-hex"
    ? Buffer.from(sha.digest("hex")).toString("base64")
    : sha.digest().toString("base64");
}
