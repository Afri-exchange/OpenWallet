import { createDecipheriv } from "node:crypto";
import type { BillingAddress, CardDetails } from "../../../../adapters/cardVault/CardVault.js";
import { validateDetails } from "../../../../adapters/cardVault/CardVault.js";
import type { MidenClient } from "./MidenClient.js";

/**
 * Decrypting Miden's `secureCardDetails` (base64 AES-128-CBC, PKCS7, JSON inside).
 *
 * The docs disagree with themselves (docs.miden.co/decrypt-encrypted-card-details-copy.md, read 2026-10-19):
 * - key material: the decrypt page says **ClientId**; the encrypt page (outgoing card payments) and our
 *   onboarding notes say **UniqueKey** (dashes removed);
 * - order: the decrypt prose says key = first 16 chars, IV = last 16, but every code sample (and the page's
 *   own sample vector, checked in test/card-details.test.ts) is key = LAST 16, IV = FIRST 16.
 * So we try each candidate and accept the first that unpads and parses into valid card details. A wrong
 * key passes PKCS7 about 1 time in 256; the JSON and digit checks after it make a false accept negligible.
 * The winning scheme name (never the key) is returned so the first live card can pin it.
 */
export interface DetailKeys {
  clientId: string;
  uniqueKey: string;
}

interface Candidate {
  scheme: string;
  key: Buffer;
  iv: Buffer;
}

function candidates(keys: DetailKeys): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const sources: [string, string][] = [
    ["clientId", keys.clientId],
    ["uniqueKey", keys.uniqueKey.replace(/-/g, "")],
    ["clientId-nodash", keys.clientId.replace(/-/g, "")],
  ];
  for (const [name, s] of sources) {
    if (!s || s.length < 16) continue;
    const first = s.slice(0, 16), last = s.slice(-16);
    for (const [order, k, iv] of [["key=last16,iv=first16", last, first], ["key=first16,iv=last16", first, last]] as const) {
      const id = `${k}\u0000${iv}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ scheme: `${name}:${order}`, key: Buffer.from(k, "utf8"), iv: Buffer.from(iv, "utf8") });
    }
  }
  return out;
}

/** Field names come back PascalCase (decrypted) or camelCase (full-PAN, docs sample): match case-insensitively. */
function field(o: Record<string, unknown>, ...names: string[]): string | undefined {
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const [k, v] of Object.entries(o)) {
    if (want.has(k.toLowerCase()) && (typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

/** "0328", "03/28", "03/2028", "2028-03", "2028-03-31T00:00:00". */
export function parseExpiry(raw: string): { expMonth: number; expYear: number } {
  let m: RegExpMatchArray | null;
  let month: number, year: number;
  if ((m = raw.match(/^(\d{4})-(\d{2})/))) [year, month] = [Number(m[1]), Number(m[2])];
  else if ((m = raw.match(/^(\d{2})\s*\/?\s*(\d{2}|\d{4})$/))) [month, year] = [Number(m[1]), Number(m[2])];
  else throw new Error("card details: unrecognised expiry format");
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) throw new Error("card details: bad expiry month");
  return { expMonth: month, expYear: year };
}

/** Builds CardDetails from a Miden object (decrypted JSON or a full-PAN `data`); throws if anything is missing or malformed. */
/** Cardholder fields that come from full-PAN, not from secureCardDetails. */
type Holder = Pick<CardDetails, "nameOnCard" | "billingZip" | "billingAddress">;

function addHolder(d: CardDetails, extra: Holder): void {
  if (extra.nameOnCard) d.nameOnCard = extra.nameOnCard;
  if (extra.billingZip) d.billingZip = extra.billingZip;
  if (extra.billingAddress) d.billingAddress = extra.billingAddress;
}

export function toCardDetails(o: Record<string, unknown>, extra: Holder = {}): CardDetails {
  const pan = field(o, "CardNumber", "pan")?.replace(/[\s-]/g, "");
  const cvv = field(o, "SecurityCode", "cvv", "cvv2");
  const exp = field(o, "Expiration", "expiryDate") ?? field(o, "ExpirationDate");
  if (!pan || !cvv || !exp) throw new Error("card details: missing card number, security code or expiration");
  const d: CardDetails = { pan, cvv, ...parseExpiry(exp) };
  addHolder(d, extra);
  validateDetails(d);
  return d;
}

/** Decrypts `secureCardDetails`. Throws (with no card data or key material in the message) if no candidate works. */
export function decryptSecureCardDetails(cipherTextB64: string, keys: DetailKeys): { details: CardDetails; scheme: string } {
  const ct = Buffer.from(cipherTextB64, "base64");
  if (ct.length === 0 || ct.length % 16 !== 0) throw new Error("secureCardDetails is not a whole number of AES blocks");
  for (const c of candidates(keys)) {
    let plain: Buffer;
    try {
      const d = createDecipheriv("aes-128-cbc", c.key, c.iv);
      plain = Buffer.concat([d.update(ct), d.final()]);
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(plain.toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object") return { details: toCardDetails(parsed as Record<string, unknown>), scheme: c.scheme };
    } catch {
      // Unpadded but not our JSON: a false PKCS7 accept. Try the next candidate.
    } finally {
      plain.fill(0);
    }
  }
  throw new Error("secureCardDetails: no key/IV candidate decrypted it (check MIDEN_CLIENT_ID / MIDEN_UNIQUE_KEY)");
}

interface FullPanResponse {
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
  data?: Record<string, unknown> & {
    firstName?: string;
    lastName?: string;
    secureCardDetails?: string;
    billingDetails?: MidenBillingDetails;
  };
}

/** full-PAN `billingDetails` (sandbox, 2026-10-19). Empty strings mean "not set". */
interface MidenBillingDetails {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

const text = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s.trim() : undefined);

/** A street address only when line1, city and country are all present; a partial one would fail at checkout anyway. */
export function toBillingAddress(b: MidenBillingDetails | undefined): BillingAddress | undefined {
  const line1 = text(b?.addressLine1);
  const city = text(b?.city);
  const country = text(b?.country);
  if (!line1 || !city || !country) return undefined;
  const a: BillingAddress = { line1, city, country };
  const line2 = text(b?.addressLine2);
  const state = text(b?.state);
  if (line2) a.line2 = line2;
  if (state) a.state = state;
  return a;
}

/**
 * GET api/v1/cards/details/{cardId}/full-pan: the recovery path when capture at issue failed.
 * Prefers the plain cardNumber/securityCode fields; falls back to decrypting secureCardDetails.
 * Does not exist on every program (we may only get the card number once), so a failure is expected.
 */
export async function fetchFullCardDetails(miden: MidenClient, cardId: string, keys: DetailKeys): Promise<{ details: CardDetails; scheme: string }> {
  const res = await miden.request<FullPanResponse>("GET", `/api/v1/cards/details/${encodeURIComponent(cardId)}/full-pan`);
  const data = res.data;
  if (res.isSuccessful !== true || res.responseCode !== "000" || !data) {
    throw new Error(`Miden full-PAN lookup failed: ${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`);
  }
  const name = [data.firstName, data.lastName].filter((s) => typeof s === "string" && s.trim()).join(" ") || undefined;
  const extra: Holder = { nameOnCard: name, billingZip: text(data.billingDetails?.zipCode), billingAddress: toBillingAddress(data.billingDetails) };
  try {
    return { details: toCardDetails(data, extra), scheme: "full-pan:plain" };
  } catch {
    if (typeof data.secureCardDetails !== "string") throw new Error("Miden full-PAN response had no usable card details");
    const r = decryptSecureCardDetails(data.secureCardDetails, keys);
    addHolder(r.details, extra);
    return r;
  }
}
