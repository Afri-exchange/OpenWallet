import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CardVaultRepository } from "../../domain/repositories/CardVaultRepository.js";

/**
 * Full card details, as captured from Miden at issue time. Never log, return to an agent, or send to a merchant:
 * only the checkout swap reads them, and only through CardVault.reveal (audited).
 */
export interface CardDetails {
  pan: string;
  cvv: string;
  /** 1-12. */
  expMonth: number;
  /** Four digits, e.g. 2028. */
  expYear: number;
  nameOnCard?: string;
  billingZip?: string;
  /**
   * Street billing address. Some Stripe Checkout sessions (tax collection, billing_address_collection=required)
   * will not submit without it; without one on file the filler stops before paying.
   */
  billingAddress?: BillingAddress;
}

export interface BillingAddress {
  line1: string;
  line2?: string;
  city: string;
  /** Two-letter state or region code, e.g. "CA". */
  state?: string;
  /** ISO 3166 alpha-2, e.g. "US". */
  country: string;
}

/** Where the details came from: the issue response's secureCardDetails, or the full-PAN endpoint. */
export type CaptureSource = "issue" | "full-pan";

export interface CardVault {
  put(cardId: string, details: CardDetails, opts?: { source?: CaptureSource }): Promise<void>;
  /** Audited: every call writes a row with `purpose` before anything is decrypted. null if nothing is stored. */
  reveal(cardId: string, purpose: string): Promise<CardDetails | null>;
  has(cardId: string): Promise<boolean>;
  /** Deletes a card's stored details (audited). For one-time cards once their checkout has been filled. */
  discard(cardId: string, purpose: string): Promise<void>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** CARD_VAULT_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). The value never appears in an error. */
export function vaultKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.CARD_VAULT_KEY;
  if (!raw) throw new Error("Missing env var CARD_VAULT_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) throw new Error(`CARD_VAULT_KEY must be ${KEY_BYTES} bytes, base64-encoded`);
  return key;
}

export function validateDetails(d: CardDetails): void {
  if (!/^\d{12,19}$/.test(d.pan)) throw new Error("card details: pan must be 12-19 digits");
  if (!/^\d{3,4}$/.test(d.cvv)) throw new Error("card details: cvv must be 3-4 digits");
  if (!Number.isInteger(d.expMonth) || d.expMonth < 1 || d.expMonth > 12) throw new Error("card details: bad expMonth");
  if (!Number.isInteger(d.expYear) || d.expYear < 2000 || d.expYear > 2099) throw new Error("card details: bad expYear");
}

function checkPurpose(purpose: string): void {
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 200) throw new Error("reveal needs a purpose (1-200 chars)");
}

/** AES-256-GCM, random 96-bit IV per record, card id bound in as AAD so a row cannot be moved to another card. */
export function seal(key: Buffer, cardId: string, details: CardDetails): { iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`card-vault:v1:${cardId}`));
  const ciphertext = Buffer.concat([c.update(JSON.stringify(details), "utf8"), c.final()]);
  return { iv, ciphertext, tag: c.getAuthTag() };
}

export function open(key: Buffer, cardId: string, box: { iv: Buffer; ciphertext: Buffer; tag: Buffer }): CardDetails {
  const d = createDecipheriv("aes-256-gcm", key, box.iv);
  d.setAAD(Buffer.from(`card-vault:v1:${cardId}`));
  d.setAuthTag(box.tag);
  return JSON.parse(Buffer.concat([d.update(box.ciphertext), d.final()]).toString("utf8")) as CardDetails;
}

/**
 * The production vault: seals details in this process (the key never reaches the database) and keeps the sealed
 * boxes and the audit trail in a CardVaultRepository.
 */
export class SealedCardVault implements CardVault {
  private readonly key: Buffer;

  /** `keyId` is stored with each row so a later key rotation can tell old rows from new. */
  constructor(private readonly repo: CardVaultRepository, key: Buffer, private readonly keyId = "v1") {
    if (key.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`);
    this.key = Buffer.from(key);
  }

  async put(cardId: string, details: CardDetails, opts: { source?: CaptureSource } = {}): Promise<void> {
    validateDetails(details);
    await this.repo.store(cardId, { keyId: this.keyId, ...seal(this.key, cardId, details) }, { last4: details.pan.slice(-4), source: opts.source ?? "issue" });
  }

  async reveal(cardId: string, purpose: string): Promise<CardDetails | null> {
    checkPurpose(purpose);
    const box = await this.repo.find(cardId);
    // The audit row is written before decrypting: no audit, no reveal.
    await this.repo.audit(cardId, box ? "reveal" : "reveal_miss", purpose);
    if (!box) return null;
    if (box.keyId !== this.keyId) throw new Error(`card ${cardId} is sealed under vault key ${box.keyId}, this process has ${this.keyId}`);
    return open(this.key, cardId, box);
  }

  has(cardId: string): Promise<boolean> {
    return this.repo.exists(cardId);
  }

  async discard(cardId: string, purpose: string): Promise<void> {
    checkPurpose(purpose);
    if (await this.repo.remove(cardId)) await this.repo.audit(cardId, "discard", purpose);
  }
}

/** In-memory vault for tests: same sealing and audit semantics, no database. */
export class MemoryCardVault implements CardVault {
  readonly audit: { cardId: string; action: string; purpose: string }[] = [];
  private readonly rows = new Map<string, ReturnType<typeof seal>>();
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(KEY_BYTES)) {
    this.key = Buffer.from(key);
  }

  async put(cardId: string, details: CardDetails, opts: { source?: CaptureSource } = {}): Promise<void> {
    validateDetails(details);
    const existed = this.rows.has(cardId);
    this.rows.set(cardId, seal(this.key, cardId, details));
    this.audit.push({ cardId, action: existed ? "overwrite" : "put", purpose: `capture:${opts.source ?? "issue"}` });
  }

  async reveal(cardId: string, purpose: string): Promise<CardDetails | null> {
    checkPurpose(purpose);
    const box = this.rows.get(cardId);
    this.audit.push({ cardId, action: box ? "reveal" : "reveal_miss", purpose });
    return box ? open(this.key, cardId, box) : null;
  }

  async has(cardId: string): Promise<boolean> {
    return this.rows.has(cardId);
  }

  async discard(cardId: string, purpose: string): Promise<void> {
    checkPurpose(purpose);
    if (this.rows.delete(cardId)) this.audit.push({ cardId, action: "discard", purpose });
  }
}
