import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type pg from "pg";

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

/** Postgres vault (tables card_vault, card_vault_audit: migration 008). Run PgStore.migrate() first. */
export class PgCardVault implements CardVault {
  private readonly key: Buffer;

  /** `keyId` is stored with each row so a later key rotation can tell old rows from new. */
  constructor(private readonly pool: pg.Pool, key: Buffer, private readonly keyId = "v1") {
    if (key.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`);
    this.key = Buffer.from(key);
  }

  async put(cardId: string, details: CardDetails, opts: { source?: CaptureSource } = {}): Promise<void> {
    validateDetails(details);
    const box = seal(this.key, cardId, details);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ inserted: boolean }>(
        `INSERT INTO card_vault (card_id, key_id, iv, ciphertext, tag, last4, source) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (card_id) DO UPDATE SET key_id = $2, iv = $3, ciphertext = $4, tag = $5, last4 = $6, source = $7, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [cardId, this.keyId, box.iv, box.ciphertext, box.tag, details.pan.slice(-4), opts.source ?? "issue"],
      );
      await client.query("INSERT INTO card_vault_audit (card_id, action, purpose) VALUES ($1, $2, $3)", [
        cardId, r.rows[0]!.inserted ? "put" : "overwrite", `capture:${opts.source ?? "issue"}`,
      ]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async reveal(cardId: string, purpose: string): Promise<CardDetails | null> {
    checkPurpose(purpose);
    const r = await this.pool.query<{ key_id: string; iv: Buffer; ciphertext: Buffer; tag: Buffer }>(
      "SELECT key_id, iv, ciphertext, tag FROM card_vault WHERE card_id = $1", [cardId],
    );
    const row = r.rows[0];
    // The audit row is written before decrypting: no audit, no reveal.
    await this.pool.query("INSERT INTO card_vault_audit (card_id, action, purpose) VALUES ($1, $2, $3)", [cardId, row ? "reveal" : "reveal_miss", purpose]);
    if (!row) return null;
    if (row.key_id !== this.keyId) throw new Error(`card ${cardId} is sealed under vault key ${row.key_id}, this process has ${this.keyId}`);
    return open(this.key, cardId, row);
  }

  async has(cardId: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM card_vault WHERE card_id = $1", [cardId])).rowCount === 1;
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
}
