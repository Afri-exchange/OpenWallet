import { createHash, createPublicKey, publicEncrypt, randomUUID, verify, constants } from "node:crypto";
import type { Ledger } from "../ledger/ledger.js";
import { baseUnitsToCents } from "../ledger/units.js";
import { BASE_SEPOLIA_USDC, ETHEREUM_SEPOLIA_USDC } from "./base-usdc-watcher.js";

/**
 * Circle developer-controlled wallets as the deposit rail (sandbox): each card gets a Circle wallet created on
 * the fly, and Circle tells us about inbound USDC by webhook instead of us polling a chain. API shapes follow
 * developers.circle.com (create wallet, notification subscriptions, notification signatures); the inbound
 * payload field names have not yet been checked against a live Circle delivery, so the handler re-reads the
 * transaction from Circle's API and trusts that, not the webhook body.
 */

export const CIRCLE_API = "https://api.circle.com";
/** Circle blockchain id -> the ledger chain label the watcher rail already uses for that network. */
export const CIRCLE_CHAINS: Record<string, string> = { "BASE-SEPOLIA": "base-sepolia", "ETH-SEPOLIA": "ethereum-sepolia" };
/** The only USDC contract credited per Circle blockchain: a token that merely calls itself "USDC" is not enough. */
export const CIRCLE_USDC: Record<string, string> = { "BASE-SEPOLIA": BASE_SEPOLIA_USDC, "ETH-SEPOLIA": ETHEREUM_SEPOLIA_USDC };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Unknown notification key ids we will look up per minute, so an anonymous caller cannot make us spam Circle. */
const KEY_LOOKUPS_PER_MIN = 20;

type Fetch = typeof fetch;

export interface CircleOptions {
  apiKey: string;
  /** 32 random bytes as 64 hex characters, registered with Circle (see docs/circle-deposits.md). */
  entitySecretHex: string;
  walletSetId: string;
  blockchain?: string;
  baseUrl?: string;
  fetch?: Fetch;
}

export class CircleError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** A UUID derived from text, so retrying "create the wallet for index 7" is the same request to Circle. */
export function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export class CircleClient {
  private readonly base: string;
  private readonly f: Fetch;
  private pem: string | undefined;
  private readonly keys = new Map<string, { algorithm: string; publicKey: string }>();
  private lookups: number[] = [];
  private readonly tokens = new Map<string, CircleToken>();

  constructor(private readonly o: CircleOptions) {
    if (!/^[0-9a-fA-F]{64}$/.test(o.entitySecretHex)) throw new Error("the Circle entity secret must be 64 hex characters");
    this.base = o.baseUrl ?? CIRCLE_API;
    this.f = o.fetch ?? fetch;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json", "x-request-id": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = "";
      try { msg = (JSON.parse(text) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
      throw new CircleError(`Circle ${method} ${path} -> ${res.status}${msg ? `: ${msg}` : ""}`, res.status);
    }
    return JSON.parse(text) as T;
  }

  /** The entity secret, RSA-OAEP (SHA-256) encrypted with Circle's public key. Circle wants a fresh one per request. */
  async entitySecretCiphertext(): Promise<string> {
    this.pem ??= (await this.call<{ data: { publicKey: string } }>("GET", "/v1/w3s/config/entity/publicKey")).data.publicKey;
    return publicEncrypt(
      { key: this.pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(this.o.entitySecretHex, "hex"),
    ).toString("base64");
  }

  /** One wallet for a deposit index. The idempotency key is derived from the index: a retry returns the same wallet. */
  async createDepositWallet(index: number): Promise<{ id: string; address: string }> {
    const r = await this.call<{ data: { wallets: { id: string; address: string }[] } }>("POST", "/v1/w3s/developer/wallets", {
      idempotencyKey: uuidFrom(`agent-cards-deposit-wallet:${this.o.walletSetId}:${index}`),
      entitySecretCiphertext: await this.entitySecretCiphertext(),
      walletSetId: this.o.walletSetId,
      blockchains: [this.o.blockchain ?? "BASE-SEPOLIA"],
      accountType: "EOA",
      count: 1,
      metadata: [{ name: `agent-cards deposit ${index}`, refId: String(index) }],
    });
    const w = r.data.wallets[0];
    if (!w || !/^0x[0-9a-fA-F]{40}$/.test(w.address)) throw new CircleError("Circle returned no usable wallet address");
    return { id: w.id, address: w.address.toLowerCase() };
  }

  async createWalletSet(name: string): Promise<string> {
    const r = await this.call<{ data: { walletSet: { id: string } } }>("POST", "/v1/w3s/developer/walletSets", {
      idempotencyKey: randomUUID(), entitySecretCiphertext: await this.entitySecretCiphertext(), name,
    });
    return r.data.walletSet.id;
  }

  /** Points Circle's webhooks at `endpoint` (public HTTPS). */
  async subscribe(endpoint: string): Promise<{ id: string }> {
    return (await this.call<{ data: { id: string } }>("POST", "/v2/notifications/subscriptions", { endpoint, notificationTypes: ["transactions.inbound"] })).data;
  }

  async notificationKey(keyId: string): Promise<{ algorithm: string; publicKey: string }> {
    const hit = this.keys.get(keyId);
    if (hit) return hit;
    const t = Date.now();
    this.lookups = this.lookups.filter((x) => t - x < 60_000);
    if (this.lookups.length >= KEY_LOOKUPS_PER_MIN) throw new CircleError("too many notification key lookups", 429);
    this.lookups.push(t);
    const k = (await this.call<{ data: { algorithm: string; publicKey: string } }>("GET", `/v2/notifications/publicKey/${encodeURIComponent(keyId)}`)).data;
    this.keys.set(keyId, k);
    return k;
  }

  async transaction(id: string): Promise<CircleTx> {
    return (await this.call<{ data: { transaction: CircleTx } }>("GET", `/v1/w3s/transactions/${encodeURIComponent(id)}`)).data.transaction;
  }

  /** Inbound transactions since `from` (one page of up to 50, newest first), for catching up on missed webhooks. */
  async recentInbound(from: Date): Promise<CircleTx[]> {
    const q = new URLSearchParams({ txType: "INBOUND", state: "COMPLETE", blockchain: this.o.blockchain ?? "BASE-SEPOLIA", from: from.toISOString(), pageSize: "50" });
    return (await this.call<{ data: { transactions: CircleTx[] } }>("GET", `/v1/w3s/transactions?${q}`)).data.transactions;
  }

  async token(tokenId: string): Promise<CircleToken> {
    const hit = this.tokens.get(tokenId);
    if (hit) return hit;
    const t = (await this.call<{ data: { token: CircleToken } }>("GET", `/v1/w3s/tokens/${encodeURIComponent(tokenId)}`)).data.token;
    this.tokens.set(tokenId, t);
    return t;
  }
}

export interface CircleToken { symbol?: string; blockchain?: string; tokenAddress?: string; decimals?: number }

export interface CircleTx {
  id: string;
  blockchain?: string;
  tokenId?: string;
  destinationAddress?: string;
  transactionType?: string;
  state?: string;
  amounts?: string[];
  txHash?: string;
}

/** Verifies Circle's ECDSA-SHA256 signature over the raw request body. The key is base64 SPKI DER (or PEM). */
export function verifyCircleSignature(rawBody: string, signatureB64: string, publicKey: string): boolean {
  try {
    const key = publicKey.includes("BEGIN") ? createPublicKey(publicKey) : createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(rawBody, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** A decimal USDC amount ("12.5") to 6-decimal base units; null for anything that is not a plain positive decimal. */
export function usdcToBaseUnits(amount: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]! + (m[2] ?? "").padEnd(6, "0"));
}

export type CircleOutcome =
  | { status: "credited"; cardId: string; amountCents: number; chain: string; isNew: boolean }
  | { status: "ignored"; reason: string };

export interface CircleDepositsDeps {
  circle: Pick<CircleClient, "notificationKey" | "transaction" | "token"> & Partial<Pick<CircleClient, "recentInbound">>;
  ledger: Ledger;
  addresses: { cardFor(address: string): Promise<string | undefined> };
  /** Called for every credit that was new (not a redelivery). */
  onCredited?: (r: Extract<CircleOutcome, { status: "credited" }>) => void;
  onDust?: (d: { txHash: string; dustBase: bigint }) => void;
}

/** Turns Circle `transactions.inbound` webhooks into ledger credits. Throws on anything Circle should retry. */
export class CircleDeposits {
  constructor(private readonly d: CircleDepositsDeps) {}

  /** @throws CircleError with status 401 for a bad signature; any other throw means "retry later". */
  async handle(rawBody: string, headers: { signature?: string; keyId?: string }): Promise<CircleOutcome> {
    if (!headers.signature || !headers.keyId) throw new CircleError("missing signature headers", 401);
    if (!UUID.test(headers.keyId)) throw new CircleError("bad key id", 401);
    let key;
    try {
      key = await this.d.circle.notificationKey(headers.keyId);
    } catch (e) {
      // Circle not knowing the key id is the caller's fault (401); anything else is ours (retry).
      if (e instanceof CircleError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) throw new CircleError("unknown key id", 401);
      throw e;
    }
    if (!verifyCircleSignature(rawBody, headers.signature, key.publicKey)) throw new CircleError("bad signature", 401);

    let body: { notificationType?: string; notification?: { id?: string } };
    try { body = JSON.parse(rawBody); } catch { return { status: "ignored", reason: "not JSON" }; }
    if (body.notificationType !== "transactions.inbound") return { status: "ignored", reason: `type ${String(body.notificationType)}` };
    const id = body.notification?.id;
    if (typeof id !== "string" || !id) return { status: "ignored", reason: "no transaction id" };

    // The signed body says which transaction; the amounts come from Circle's API, not from the body.
    return this.credit(await this.d.circle.transaction(id));
  }

  /**
   * Catch-up for webhooks Circle could not deliver (tunnel down, service restarting): credits every COMPLETE
   * inbound USDC transfer from the last `lookbackMs` that the ledger has not seen. Safe to run often: the
   * ledger key makes a repeat a no-op. Looks at one page of 50, so a longer outage needs a longer pass.
   */
  async reconcile(lookbackMs = 2 * 3600_000): Promise<{ checked: number; credited: number }> {
    if (!this.d.circle.recentInbound) throw new Error("this Circle client cannot list transactions");
    const txs = await this.d.circle.recentInbound(new Date(Date.now() - lookbackMs));
    let credited = 0;
    for (const tx of txs) {
      const r = await this.credit(tx);
      if (r.status === "credited" && r.isNew) credited++;
    }
    return { checked: txs.length, credited };
  }

  private async credit(tx: CircleTx): Promise<CircleOutcome> {
    if (tx.transactionType !== "INBOUND") return { status: "ignored", reason: "not inbound" };
    if (tx.state !== "COMPLETE") return { status: "ignored", reason: `state ${String(tx.state)}` };
    const chain = tx.blockchain ? CIRCLE_CHAINS[tx.blockchain] : undefined;
    if (!chain) return { status: "ignored", reason: `unsupported blockchain ${String(tx.blockchain)}` };
    // Cheapest checks first: most listed transfers are not to our addresses, and each token lookup is an API call.
    const cardId = tx.destinationAddress ? await this.d.addresses.cardFor(tx.destinationAddress) : undefined;
    if (!cardId) return { status: "ignored", reason: "not one of our deposit addresses" };
    const token = tx.tokenId ? await this.d.circle.token(tx.tokenId) : undefined;
    if (!token || token.symbol !== "USDC" || token.blockchain !== tx.blockchain || token.decimals !== 6 || token.tokenAddress?.toLowerCase() !== CIRCLE_USDC[tx.blockchain!]) {
      return { status: "ignored", reason: "not the pinned USDC contract" };
    }
    if (!tx.txHash || tx.amounts?.length !== 1) return { status: "ignored", reason: "unexpected transaction shape" };
    const base = usdcToBaseUnits(tx.amounts[0]!);
    if (!base || base === 0n) return { status: "ignored", reason: "bad amount" };
    const { cents, dustBase } = baseUnitsToCents(base, 6);
    if (cents === 0) return { status: "ignored", reason: "under one cent" };

    const label = `circle-${chain}`;
    // Only for the log line: whether this call is the one that credits. The ledger key is what prevents a double credit.
    const isNew = !(await this.d.ledger.findByKey(`deposit:${label}:${tx.txHash.toLowerCase()}:0`));
    await this.d.ledger.confirmDeposit({ chain: label, asset: "USDC", cardId, amountCents: cents, txHash: tx.txHash, logIndex: 0 });
    const out = { status: "credited", cardId, amountCents: cents, chain, isNew } as const;
    if (isNew) {
      if (dustBase > 0n) this.d.onDust?.({ txHash: tx.txHash, dustBase });
      this.d.onCredited?.(out);
    }
    return out;
  }
}
