import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { accounts, LedgerError, type Ledger } from "../services/Ledger.js";
import { type AgentPrincipal, type PayRequest, type SpendView } from "./CardholderInteractor.js";
import { badRequestError, conflictError, goneError, notFoundError } from "../../errors.js";

/**
 * Checkouts: a merchant creates a checkout with a fixed price, an agent pays it with its owner's card.
 * The payment is an ordinary agent payment (CardholderInteractor.pay), so the agent's limits, balance, MCC allowlist,
 * idempotency and reconcile all apply. A checkout is paid at most once:
 *
 *   open --claim--> processing --approved--> paid
 *                       | declined / voided / error before any charge: back to open (another attempt may follow)
 *                       | card answer lost: stays processing until the spend settles (sync)
 *   open --merchant--> canceled        open --time--> expired
 *
 * Each claim is a new attempt with its own spend key (checkout:<id>:<attempt>), so a payment declined for
 * low balance can be retried after a top-up, while a retry of the same attempt never charges twice.
 *
 * Settlement: we are the merchant of record, so a paid checkout credits the merchant's balance in our ledger
 * (once per checkout: key checkout-settle:<id>), and merchants are paid out from that balance. Card details
 * never reach the merchant or the agent. A charge approved after its checkout moved on is not credited.
 */

export interface CheckoutContext {
  pool: pg.Pool;
  ledger: Pick<Ledger, "balance" | "findByKey" | "settleCheckout" | "reservePayout" | "completePayout" | "releasePayout">;
  /** CardholderInteractor; checkout payments use its reserved "checkout:" keys (internal: true). */
  app: { pay(p: AgentPrincipal, req: PayRequest, opts: { internal: true }): Promise<SpendView> };
  /** Where /pay/<id> pages are served, e.g. http://127.0.0.1:8787. */
  publicUrl: string;
  /** How long a newly set payout address waits before payouts to it are allowed. Default 24 h. */
  payoutAddressDelayMs?: number;
  /** True for addresses we control (deposit addresses, the payout account): paying one would credit a card or loop. */
  isOwnAddress?: (address: string) => Promise<boolean>;
  now?: () => Date;
  log?: (msg: string) => void;
}

export type CheckoutStatus = "open" | "processing" | "paid" | "canceled" | "expired";

export interface CreateCheckoutRequest {
  amountCents: number;
  description: string;
  /** The merchant's own order id; echoed back. */
  reference?: string;
  /** Overrides the merchant's default category. */
  mcc?: string;
  /** Default 30 minutes; 60 s to 24 h. */
  expiresInSeconds?: number;
  /** Merchant-only; never shown to agents. At most 4 KB of JSON. */
  metadata?: Record<string, unknown>;
  /** Same key + same checkout = the same checkout, never a second one. */
  idempotencyKey?: string;
}

/** What the merchant sees. */
export interface MerchantCheckoutView {
  checkoutId: string;
  status: CheckoutStatus;
  amountCents: number;
  currency: "USD";
  description: string;
  reference: string | null;
  mcc: string | null;
  metadata: Record<string, unknown> | null;
  checkoutUrl: string;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  /** The card payment, once one is under way or done. */
  payment: { paymentId: string; status: SpendView["status"] } | null;
  /** "failed" when the last agent's attempt did not go through (it is still open for another try). No reasons: they are the payer's private limits. */
  lastAttempt: "failed" | null;
  /** Set when a person has to look at this payment (the card network has no answer yet, or a charge did not match). Do not fulfil. */
  underReview: string | null;
}

/** What anyone with the checkout id sees (the /pay page, an agent before paying). */
export interface PublicCheckoutView {
  checkoutId: string;
  merchant: string;
  description: string;
  amountCents: number;
  currency: "USD";
  status: CheckoutStatus;
  expiresAt: string;
}

export interface MerchantBalance {
  /** Paid checkouts not yet paid out: what a payout can draw on. */
  availableCents: number;
  /** Payouts requested and not yet confirmed sent. */
  pendingPayoutCents: number;
  currency: "USD";
}

export type PayoutStatus = "requested" | "sending" | "sent" | "failed";

export interface PayoutView {
  payoutId: string;
  amountCents: number;
  currency: "USD";
  status: PayoutStatus;
  /** Where it goes: USDC on this chain, to this address (fixed when the payout was requested). */
  chain: string | null;
  destination: string | null;
  /** The on-chain transfer, once signed. */
  txHash: string | null;
  failure: string | null;
  createdAt: string;
}

export interface MerchantProfile {
  merchantId: string;
  name: string;
  email: string;
  mcc: string | null;
  payoutAddress: string | null;
  /** Payouts to payoutAddress are allowed from this time (a change waits, against account takeover). */
  payoutAddressUsableFrom: string | null;
}

/** Payouts are USDC on Base Sepolia (testnet) for now; bank transfers come later. */
export const PAYOUT_CHAIN = "base-sepolia";
const DEFAULT_PAYOUT_ADDRESS_DELAY_MS = 24 * 3_600_000;

export interface CheckoutPayResult {
  checkout: PublicCheckoutView;
  payment: SpendView;
}

const DEFAULT_TTL_S = 30 * 60;
/** A claim with no spend row this long after it was made is a crash between claim and payment: released. */
const STALE_CLAIM_MS = 10 * 60_000;
const MAX_METADATA_BYTES = 4_096;

const hashKey = (t: string) => createHash("sha256").update(t).digest("hex");
const spendKey = (checkoutId: string, attempt: number) => `checkout:${checkoutId}:${attempt}`;
const num = (v: string | number | null) => (v === null ? 0 : Number(v));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw badRequestError(`${what} is required`);
  if (v.length > max) throw badRequestError(`${what} is too long (at most ${max} characters)`);
  return v.trim();
}
const optText = (v: unknown, what: string, max: number) => (v === undefined || v === null || v === "" ? undefined : text(v, what, max));
function optMcc(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const m = String(v);
  if (!/^\d{4}$/.test(m)) throw badRequestError("mcc must be 4 digits");
  return m;
}

export class CheckoutInteractor {
  /** Pay attempts running in this process, by checkout id; sync leaves them alone. */
  private readonly paying = new Map<string, Promise<unknown>>();
  private syncRun: Promise<void> | undefined;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: CheckoutContext) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
  }

  // ---------- merchants ----------

  async createMerchant(body: { name?: unknown; email?: unknown; mcc?: unknown }): Promise<{ merchantId: string; name: string; secretKey: string }> {
    const name = text(body.name, "name", 80);
    const email = text(body.email, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequestError("email is not valid");
    const mcc = optMcc(body.mcc);
    const merchantId = `m_${randomBytes(6).toString("hex")}`;
    const secretKey = `mk_${randomBytes(32).toString("base64url")}`;
    try {
      await this.d.pool.query("INSERT INTO app_merchant (merchant_id, name, email, mcc, key_hash) VALUES ($1, $2, $3, $4, $5)", [merchantId, name, email, mcc ?? null, hashKey(secretKey)]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflictError("that email already has a merchant account");
      throw e;
    }
    return { merchantId, name, secretKey };
  }

  async merchantByKey(key: string): Promise<string | undefined> {
    const r = await this.d.pool.query("SELECT merchant_id FROM app_merchant WHERE key_hash = $1", [hashKey(key)]);
    return r.rows[0]?.merchant_id;
  }

  /** Replaces the merchant's secret key; the old one stops working at once. */
  async rotateMerchantKey(merchantId: string): Promise<{ secretKey: string }> {
    const secretKey = `mk_${randomBytes(32).toString("base64url")}`;
    await this.d.pool.query("UPDATE app_merchant SET key_hash = $2 WHERE merchant_id = $1", [merchantId, hashKey(secretKey)]);
    return { secretKey };
  }

  async merchantProfile(merchantId: string): Promise<MerchantProfile> {
    const m = await this.merchant(merchantId);
    return { merchantId, name: m.name, email: m.email, mcc: m.mcc, payoutAddress: m.payout_address, payoutAddressUsableFrom: this.usableFrom(m)?.toISOString() ?? null };
  }

  /**
   * Sets where payouts go (USDC on Base Sepolia). A new address can be paid only after the delay, so a stolen
   * secret key cannot redirect money at once; payouts already requested keep the address they were requested to.
   * TODO before production: also require re-authentication (email confirmation) and notify the old contact.
   */
  async setPayoutAddress(merchantId: string, body: { address?: unknown }): Promise<MerchantProfile> {
    await this.merchant(merchantId);
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw badRequestError("address must be a 0x-prefixed EVM address");
    if (/^0x0{40}$/.test(address)) throw badRequestError("address cannot be the zero address");
    if (await this.d.isOwnAddress?.(address)) throw badRequestError("that address belongs to Agent Cards; use your own wallet");
    await this.d.pool.query(
      "UPDATE app_merchant SET payout_address = $2, payout_address_set_at = $3 WHERE merchant_id = $1 AND payout_address IS DISTINCT FROM $2",
      [merchantId, address, this.now()],
    );
    this.log(`merchant ${merchantId}: payout address set to ${address}`);
    return this.merchantProfile(merchantId);
  }

  private usableFrom(m: Record<string, any>): Date | undefined {
    if (!m.payout_address_set_at) return undefined;
    return new Date((m.payout_address_set_at as Date).getTime() + (this.d.payoutAddressDelayMs ?? DEFAULT_PAYOUT_ADDRESS_DELAY_MS));
  }

  // ---------- merchant balance and payouts ----------

  async balance(merchantId: string): Promise<MerchantBalance> {
    await this.merchant(merchantId);
    const [availableCents, pendingPayoutCents] = await Promise.all([
      this.d.ledger.balance(accounts.merchantBalance(merchantId)),
      this.d.ledger.balance(accounts.payoutPending(merchantId)),
    ]);
    return { availableCents, pendingPayoutCents, currency: "USD" };
  }

  /**
   * Reserves the amount (balance -> pending) BEFORE anything is sent, so the money cannot be paid out twice.
   * The payout sender (PayoutInteractor) then transfers it as USDC to the merchant's payout address.
   */
  async requestPayout(merchantId: string, body: { amountCents?: unknown; idempotencyKey?: unknown }): Promise<PayoutView> {
    const m = await this.merchant(merchantId);
    const amountCents = body.amountCents;
    if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequestError("amountCents must be a positive whole number of cents");
    const key = optText(body.idempotencyKey, "idempotencyKey", 100);
    if (key) {
      const prior = (await this.d.pool.query("SELECT * FROM app_payout WHERE merchant_id = $1 AND idempotency_key = $2", [merchantId, key])).rows[0];
      if (prior) {
        if (num(prior.amount_cents) !== amountCents) throw conflictError("that idempotency key was already used for a different payout");
        return payoutRow(prior);
      }
    }
    if (!m.payout_address) throw conflictError("set a payout address first (POST /merchant/v1/payout-address)");
    const from = this.usableFrom(m)!;
    if (this.now() < from) throw conflictError(`your payout address was changed recently; payouts to it are allowed from ${from.toISOString()}`);
    const payoutId = `po_${randomBytes(12).toString("hex")}`;
    try {
      // The row first, so a crash after the reservation leaves a payout ops can see.
      await this.d.pool.query(
        "INSERT INTO app_payout (payout_id, merchant_id, amount_cents, status, idempotency_key, destination, chain) VALUES ($1, $2, $3, 'requested', $4, $5, $6)",
        [payoutId, merchantId, amountCents, key ?? null, m.payout_address, PAYOUT_CHAIN],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505" && key) return this.requestPayout(merchantId, body);
      throw e;
    }
    try {
      await this.d.ledger.reservePayout({ merchantId, amountCents, payoutId });
    } catch (e) {
      // Failed only if nothing was reserved; a reservation that committed before the error stands.
      if (!(await this.d.ledger.findByKey(`payout-reserve:${payoutId}`))) {
        const short = e instanceof LedgerError && /insufficient/.test(e.message);
        await this.d.pool.query("UPDATE app_payout SET status = 'failed', failure = $2, updated_at = now() WHERE payout_id = $1 AND status = 'requested'", [payoutId, short ? "insufficient balance" : "could not reserve funds"]);
        if (short) throw conflictError("payout is more than the available balance");
      }
      throw e;
    }
    this.log(`payout ${payoutId}: ${amountCents}c reserved for ${merchantId}, to ${m.payout_address}`);
    return payoutRow((await this.d.pool.query("SELECT * FROM app_payout WHERE payout_id = $1", [payoutId])).rows[0]);
  }

  async listPayouts(merchantId: string, limit = 20): Promise<PayoutView[]> {
    const r = await this.d.pool.query("SELECT * FROM app_payout WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2", [merchantId, Math.min(Math.max(1, limit), 100)]);
    return r.rows.map(payoutRow);
  }

  /**
   * Ops (or, later, the payout rail's callback): the rail confirmed the money left, or definitely refused it.
   * Never mark a payout failed because its answer is missing: that is how money gets sent twice.
   * Invariant for any rail: it may send only payouts whose `payout-reserve:<id>` ledger entry exists. A payout row can
   * be `requested` with no reservation (reserve and its check both failed), and must never be sent in that state.
   */
  async settlePayout(
    payoutId: string,
    outcome: { sent: true; railReference?: string } | { sent: false; failure: string },
    opts: { fromRail?: boolean; afterReview?: boolean } = {},
  ): Promise<PayoutView> {
    const p = (await this.d.pool.query("SELECT * FROM app_payout WHERE payout_id = $1", [payoutId])).rows[0];
    if (!p) throw notFoundError("payout not found");
    const target = outcome.sent ? "sent" : "failed";
    const args = { merchantId: p.merchant_id as string, amountCents: num(p.amount_cents), payoutId };
    const reserved = !!(await this.d.ledger.findByKey(`payout-reserve:${payoutId}`));
    if (outcome.sent && !reserved) throw conflictError("no funds are reserved for this payout");
    // Claim the row BEFORE moving money, so ops and the sender can never both act on it: whoever claims first
    // wins. Ops may only settle a payout nothing has been broadcast for. A broadcast transfer may still be mined,
    // so only the chain's answer (fromRail) settles it, or a person after review (afterReview, needs_review set).
    const from = opts.fromRail ? "status = 'sending'" : opts.afterReview ? "status = 'sending' AND needs_review IS NOT NULL" : "status = 'requested'";
    const claimed = outcome.sent
      ? await this.d.pool.query(
          `UPDATE app_payout SET status = 'sent', rail_reference = COALESCE($2, rail_reference), updated_at = now() WHERE payout_id = $1 AND ${from} RETURNING *`,
          [payoutId, outcome.railReference ?? null],
        )
      : await this.d.pool.query(
          `UPDATE app_payout SET status = 'failed', failure = $2, updated_at = now() WHERE payout_id = $1 AND ${from} RETURNING *`,
          [payoutId, outcome.failure.slice(0, 300)],
        );
    if (!claimed.rowCount) {
      const now = (await this.d.pool.query("SELECT status FROM app_payout WHERE payout_id = $1", [payoutId])).rows[0];
      // The same terminal status again is a retry: fall through to finish the ledger step (idempotent by key).
      if (now?.status !== target) {
        if (now?.status === "sending") {
          throw conflictError(opts.afterReview ? "this payout is not under review" : "a transfer for this payout was broadcast; it is settled from the chain");
        }
        throw conflictError(`payout already ${now?.status}`);
      }
    }
    // A crash between the claim and this step leaves the money in payout_pending (never double-paid); calling
    // settlePayout again with the same outcome finishes it.
    if (outcome.sent) await this.d.ledger.completePayout(args);
    else if (reserved || (await this.d.ledger.findByKey(`payout-reserve:${payoutId}`))) await this.d.ledger.releasePayout(args);
    return payoutRow((await this.d.pool.query("SELECT * FROM app_payout WHERE payout_id = $1", [payoutId])).rows[0]);
  }

  // ---------- checkouts (merchant side) ----------

  async create(merchantId: string, body: Partial<Record<keyof CreateCheckoutRequest, unknown>>): Promise<MerchantCheckoutView> {
    const amountCents = body.amountCents;
    if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequestError("amountCents must be a positive whole number of cents");
    const description = text(body.description, "description", 200);
    const reference = optText(body.reference, "reference", 100);
    const mcc = optMcc(body.mcc);
    const ttl = body.expiresInSeconds === undefined ? DEFAULT_TTL_S : body.expiresInSeconds;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) throw badRequestError("expiresInSeconds must be a whole number from 60 to 86400");
    let metadata: Record<string, unknown> | null = null;
    if (body.metadata !== undefined && body.metadata !== null) {
      if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) throw badRequestError("metadata must be a JSON object");
      if (Buffer.byteLength(JSON.stringify(body.metadata)) > MAX_METADATA_BYTES) throw badRequestError(`metadata is too large (at most ${MAX_METADATA_BYTES} bytes)`);
      metadata = body.metadata as Record<string, unknown>;
    }
    const key = optText(body.idempotencyKey, "idempotencyKey", 100);
    const same = (c: Record<string, any>) =>
      num(c.amount_cents) === amountCents && c.description === description && (c.reference ?? undefined) === reference && (c.mcc ?? undefined) === mcc;
    if (key) {
      const prior = (await this.d.pool.query("SELECT * FROM app_checkout WHERE merchant_id = $1 AND idempotency_key = $2", [merchantId, key])).rows[0];
      if (prior) {
        if (!same(prior)) throw conflictError("that idempotency key was already used for a different checkout");
        return this.merchantView(prior);
      }
    }
    const checkoutId = `cs_${randomBytes(16).toString("hex")}`;
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);
    try {
      const r = await this.d.pool.query(
        `INSERT INTO app_checkout (checkout_id, merchant_id, amount_cents, description, reference, mcc, metadata, idempotency_key, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9) RETURNING *`,
        [checkoutId, merchantId, amountCents, description, reference ?? null, mcc ?? null, metadata, key ?? null, expiresAt],
      );
      return this.merchantView(r.rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505" && key) {
        // The same key, created concurrently.
        const prior = (await this.d.pool.query("SELECT * FROM app_checkout WHERE merchant_id = $1 AND idempotency_key = $2", [merchantId, key])).rows[0];
        if (prior && same(prior)) return this.merchantView(prior);
        throw conflictError("that idempotency key was already used for a different checkout");
      }
      throw e;
    }
  }

  async getForMerchant(merchantId: string, checkoutId: string): Promise<MerchantCheckoutView> {
    await this.syncOne(checkoutId);
    const c = await this.row(checkoutId);
    if (!c || c.merchant_id !== merchantId) throw notFoundError("checkout not found");
    return this.merchantView(c);
  }

  async list(merchantId: string, limit = 20): Promise<MerchantCheckoutView[]> {
    await this.expire();
    const r = await this.d.pool.query("SELECT * FROM app_checkout WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2", [merchantId, Math.min(Math.max(1, limit), 100)]);
    return Promise.all(r.rows.map((c) => this.merchantView(c)));
  }

  /** Only an open checkout can be canceled; one being paid or paid cannot. */
  async cancel(merchantId: string, checkoutId: string): Promise<MerchantCheckoutView> {
    await this.expire();
    const r = await this.d.pool.query(
      "UPDATE app_checkout SET status = 'canceled', updated_at = now() WHERE checkout_id = $1 AND merchant_id = $2 AND status = 'open' RETURNING *",
      [checkoutId, merchantId],
    );
    if (r.rows[0]) return this.merchantView(r.rows[0]);
    const c = await this.row(checkoutId);
    if (!c || c.merchant_id !== merchantId) throw notFoundError("checkout not found");
    if (c.status === "canceled") return this.merchantView(c);
    throw conflictError(`checkout is ${c.status} and cannot be canceled`);
  }

  // ---------- checkouts (public / agent side) ----------

  async getPublic(checkoutId: string): Promise<PublicCheckoutView> {
    await this.syncOne(checkoutId);
    const c = await this.row(checkoutId);
    if (!c) throw notFoundError("checkout not found");
    return this.publicView(c);
  }

  /**
   * The agent pays the checkout. Safe to retry: while this agent's attempt is processing, a retry returns
   * that same payment; once paid, it returns the paid result. Another agent gets a 409.
   */
  async pay(p: AgentPrincipal, checkoutIdIn: unknown, opts: { maxAmountCents?: unknown } = {}): Promise<CheckoutPayResult> {
    const checkoutId = text(checkoutIdIn, "checkout id", 64);
    const max = opts.maxAmountCents;
    if (max !== undefined && (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0)) throw badRequestError("maxAmountCents must be a positive whole number of cents");
    // One attempt per checkout at a time in this process; the conditional claim covers other processes.
    while (this.paying.has(checkoutId)) await this.paying.get(checkoutId)!.catch(() => undefined);
    const run = this.doPay(p, checkoutId, max as number | undefined);
    this.paying.set(checkoutId, run);
    try {
      return await run;
    } finally {
      this.paying.delete(checkoutId);
    }
  }

  private async doPay(p: AgentPrincipal, checkoutId: string, maxAmountCents?: number): Promise<CheckoutPayResult> {
    await this.expire();
    const mine = (c: Record<string, any>) => c.card_id === p.cardId && c.agent_id === p.agentId;
    let c = await this.row(checkoutId);
    if (c && maxAmountCents !== undefined && num(c.amount_cents) > maxAmountCents) {
      throw conflictError(`checkout costs ${num(c.amount_cents)} cents, more than the ${maxAmountCents} you allowed; nothing was charged`);
    }
    // Two rounds at most: a lost claim race re-reads the row once and then answers from its state.
    for (let round = 0; ; round++) {
      if (!c) throw notFoundError("checkout not found");
      if (c.status === "paid") {
        if (!mine(c)) throw conflictError("this checkout was already paid");
        return { checkout: await this.publicView(c), payment: await this.spendOf(c.spend_id) };
      }
      if (c.status === "canceled" || c.status === "expired") throw goneError(`checkout is ${c.status}`);
      if (c.status === "processing") {
        if (!mine(c)) throw conflictError("another agent is paying this checkout");
        break; // resume this agent's attempt: pay() returns the existing payment for its key
      }
      const claimed = await this.d.pool.query(
        `UPDATE app_checkout SET status = 'processing', card_id = $2, agent_id = $3, attempt = attempt + 1, claimed_at = $4, spend_id = NULL, updated_at = now()
         WHERE checkout_id = $1 AND status = 'open' AND expires_at > $4 RETURNING *`,
        [checkoutId, p.cardId, p.agentId, this.now()],
      );
      if (claimed.rows[0]) {
        c = claimed.rows[0];
        break;
      }
      if (round > 0) throw conflictError("checkout changed while paying; try again");
      await this.expire();
      c = await this.row(checkoutId);
    }
    const checkout = c!;
    const merchant = await this.merchant(checkout.merchant_id);
    const key = spendKey(checkoutId, checkout.attempt);
    let payment: SpendView;
    try {
      payment = await this.d.app.pay(p, {
        amountCents: num(checkout.amount_cents),
        merchant: merchant.name,
        mcc: checkout.mcc ?? merchant.mcc ?? undefined,
        idempotencyKey: key,
      }, { internal: true });
    } catch (e) {
      // Released only if no payment was recorded under this attempt's key; otherwise sync settles it.
      const s = await this.spendByKey(p.cardId, p.agentId, key);
      if (s) await this.apply(checkout, s, merchant.name);
      else await this.release(checkoutId, checkout.attempt, errText(e));
      throw e;
    }
    const after = await this.apply(checkout, payment, merchant.name);
    return { checkout: await this.publicView(after ?? (await this.row(checkoutId))!), payment };
  }

  // ---------- settling ----------

  /** Moves a claimed checkout to where its payment went. Guarded on the attempt, so a stale answer changes nothing. */
  private async apply(c: Record<string, any>, s: SpendView, merchantName: string): Promise<Record<string, any> | undefined> {
    const id = c.checkout_id as string;
    // Defence in depth: only a spend for exactly this checkout's price and merchant can pay it.
    if (s.amountCents !== num(c.amount_cents) || s.merchant !== merchantName) {
      const note = `needs review: payment ${s.spendId} (${s.amountCents}c to ${s.merchant}) does not match this checkout`;
      await this.d.pool.query("UPDATE app_checkout SET needs_review = $3, updated_at = now() WHERE checkout_id = $1 AND attempt = $2", [id, c.attempt, note]);
      this.log(`checkout ${id}: ${note}`);
      return undefined;
    }
    if (s.status === "approved") {
      const r = await this.d.pool.query(
        "UPDATE app_checkout SET status = 'paid', spend_id = $3, paid_at = $4, last_error = NULL, updated_at = now() WHERE checkout_id = $1 AND attempt = $2 AND status = 'processing' RETURNING *",
        [id, c.attempt, s.spendId, this.now()],
      );
      if (!r.rows[0]) {
        // A stalled claim was released and someone else paid: one item, two charges. Visible to the merchant and ops.
        const note = `needs review: payment ${s.spendId} (attempt ${c.attempt}) was approved after the checkout moved on`;
        await this.d.pool.query("UPDATE app_checkout SET needs_review = $2, updated_at = now() WHERE checkout_id = $1", [id, note]);
        this.log(`checkout ${id}: ${note}`);
        return undefined;
      }
      // Only the attempt that moved the checkout to paid credits the merchant. A failure here is retried by sync.
      try {
        return (await this.settle(r.rows[0])) ?? r.rows[0];
      } catch (e) {
        this.log(`checkout ${id}: settle: ${errText(e)}`);
        return r.rows[0];
      }
    }
    if (s.status === "processing") {
      const r = await this.d.pool.query(
        "UPDATE app_checkout SET spend_id = $3, updated_at = now() WHERE checkout_id = $1 AND attempt = $2 AND status = 'processing' RETURNING *",
        [id, c.attempt, s.spendId],
      );
      return r.rows[0];
    }
    return this.release(id, c.attempt, s.reason ?? s.status);
  }

  /** Credits the merchant for a paid checkout. Idempotent: the ledger key is per checkout. */
  private async settle(c: Record<string, any>): Promise<Record<string, any> | undefined> {
    const tx = await this.d.ledger.settleCheckout({ merchantId: c.merchant_id, checkoutId: c.checkout_id, amountCents: num(c.amount_cents) });
    const r = await this.d.pool.query("UPDATE app_checkout SET settled_seq = $2, updated_at = now() WHERE checkout_id = $1 AND status = 'paid' RETURNING *", [c.checkout_id, tx.seq]);
    return r.rows[0];
  }

  private async release(checkoutId: string, attempt: number, why: string): Promise<Record<string, any> | undefined> {
    const r = await this.d.pool.query(
      "UPDATE app_checkout SET status = 'open', card_id = NULL, agent_id = NULL, spend_id = NULL, claimed_at = NULL, last_error = $3, updated_at = now() WHERE checkout_id = $1 AND attempt = $2 AND status = 'processing' RETURNING *",
      [checkoutId, attempt, why.slice(0, 300)],
    );
    return r.rows[0];
  }

  /**
   * Settles checkouts left processing (lost card answer, crash) from their payments, which
   * CardholderInteractor.reconcileSpends() settles from the card. Run it in the background after that.
   */
  sync(): Promise<void> {
    this.syncRun ??= this.doSync().finally(() => (this.syncRun = undefined));
    return this.syncRun;
  }

  private async doSync(): Promise<void> {
    await this.expire();
    const rows = (await this.d.pool.query("SELECT checkout_id FROM app_checkout WHERE status = 'processing' ORDER BY claimed_at LIMIT 200")).rows;
    for (const r of rows) await this.syncOne(r.checkout_id).catch((e) => this.log(`checkout ${r.checkout_id}: sync: ${errText(e)}`));
    // Paid but not yet credited to the merchant (a crash or error between the two).
    const unsettled = (await this.d.pool.query("SELECT * FROM app_checkout WHERE status = 'paid' AND settled_seq IS NULL ORDER BY paid_at LIMIT 200")).rows;
    for (const c of unsettled) await this.settle(c).catch((e) => this.log(`checkout ${c.checkout_id}: settle: ${errText(e)}`));
    await this.finishPayouts();
  }

  /**
   * A payout row claimed sent/failed whose ledger step (complete/release) never landed (it threw, or we crashed)
   * keeps its money in payout_pending. Re-run settlePayout with the row's own outcome: idempotent by ledger key.
   * Only rows with a reservation and no closing entry are touched.
   */
  private async finishPayouts(): Promise<void> {
    const stuck = (
      await this.d.pool.query(
        `SELECT p.* FROM app_payout p
         WHERE p.status IN ('sent', 'failed')
           AND EXISTS (SELECT 1 FROM ledger_tx WHERE idempotency_key = 'payout-reserve:' || p.payout_id)
           AND NOT EXISTS (SELECT 1 FROM ledger_tx WHERE idempotency_key IN ('payout-complete:' || p.payout_id, 'payout-release:' || p.payout_id))
         ORDER BY p.updated_at LIMIT 100`,
      )
    ).rows;
    for (const p of stuck) {
      const outcome = p.status === "sent"
        ? ({ sent: true, railReference: p.rail_reference ?? undefined } as const)
        : ({ sent: false, failure: p.failure ?? "payout failed" } as const);
      await this.settlePayout(p.payout_id, outcome).catch((e) => this.log(`payout ${p.payout_id}: finish: ${errText(e)}`));
    }
  }

  private async syncOne(checkoutId: string): Promise<void> {
    if (this.paying.has(checkoutId)) return;
    const c = await this.row(checkoutId);
    if (!c || c.status !== "processing") return;
    const s = await this.spendByKey(c.card_id, c.agent_id, spendKey(checkoutId, c.attempt));
    if (s) {
      await this.apply(c, s, (await this.merchant(c.merchant_id)).name);
    } else if (this.now().getTime() - new Date(c.claimed_at).getTime() > STALE_CLAIM_MS) {
      await this.release(checkoutId, c.attempt, "interrupted before payment; nothing was charged");
      this.log(`checkout ${checkoutId}: stale claim released`);
    }
  }

  /** Open checkouts past their time become expired. A processing one is left to finish. */
  private async expire(): Promise<void> {
    await this.d.pool.query("UPDATE app_checkout SET status = 'expired', updated_at = now() WHERE status = 'open' AND expires_at <= $1", [this.now()]);
  }

  // ---------- helpers ----------

  private async row(checkoutId: string): Promise<Record<string, any> | undefined> {
    return (await this.d.pool.query("SELECT * FROM app_checkout WHERE checkout_id = $1", [checkoutId])).rows[0];
  }

  private async merchant(merchantId: string) {
    const m = (await this.d.pool.query("SELECT * FROM app_merchant WHERE merchant_id = $1", [merchantId])).rows[0];
    if (!m) throw notFoundError("merchant not found");
    return m;
  }

  private async spendByKey(cardId: string, agentId: string, key: string): Promise<SpendView | undefined> {
    const s = (await this.d.pool.query("SELECT * FROM app_spend WHERE card_id = $1 AND agent_id = $2 AND idempotency_key = $3", [cardId, agentId, key])).rows[0];
    return s ? spendRow(s) : undefined;
  }

  private async spendOf(spendId: string): Promise<SpendView> {
    return spendRow((await this.d.pool.query("SELECT * FROM app_spend WHERE spend_id = $1", [spendId])).rows[0]);
  }

  private async merchantView(c: Record<string, any>): Promise<MerchantCheckoutView> {
    let payment: MerchantCheckoutView["payment"] = null;
    let underReview: string | null = c.needs_review ? "payment under review; do not fulfil" : null;
    if (c.spend_id) {
      const s = (await this.d.pool.query("SELECT status, reason FROM app_spend WHERE spend_id = $1", [c.spend_id])).rows[0];
      if (s) payment = { paymentId: c.spend_id, status: s.status };
      if (s?.status === "processing" && /^needs review/.test(s.reason ?? "")) underReview ??= "payment under review: the card network has not confirmed it yet; do not fulfil";
    }
    return {
      checkoutId: c.checkout_id,
      status: c.status,
      amountCents: num(c.amount_cents),
      currency: "USD",
      description: c.description,
      reference: c.reference,
      mcc: c.mcc,
      metadata: c.metadata,
      checkoutUrl: this.urlOf(c.checkout_id),
      expiresAt: (c.expires_at as Date).toISOString(),
      paidAt: c.paid_at ? (c.paid_at as Date).toISOString() : null,
      createdAt: (c.created_at as Date).toISOString(),
      payment,
      lastAttempt: c.status === "open" && c.last_error ? "failed" : null,
      underReview,
    };
  }

  private async publicView(c: Record<string, any>): Promise<PublicCheckoutView> {
    const m = await this.merchant(c.merchant_id);
    return {
      checkoutId: c.checkout_id,
      merchant: m.name,
      description: c.description,
      amountCents: num(c.amount_cents),
      currency: "USD",
      status: c.status,
      expiresAt: (c.expires_at as Date).toISOString(),
    };
  }

  urlOf(checkoutId: string): string {
    return `${this.d.publicUrl.replace(/\/$/, "")}/pay/${checkoutId}`;
  }
}

function spendRow(s: Record<string, unknown>): SpendView {
  return {
    spendId: s.spend_id as string,
    amountCents: num(s.amount_cents as string),
    merchant: s.merchant as string,
    mcc: (s.mcc as string | null) ?? null,
    status: s.status as SpendView["status"],
    reason: (s.reason as string | null) ?? null,
    createdAt: (s.created_at as Date).toISOString(),
  };
}

function payoutRow(p: Record<string, any>): PayoutView {
  return {
    payoutId: p.payout_id,
    amountCents: num(p.amount_cents),
    currency: "USD",
    status: p.status,
    chain: p.chain ?? null,
    destination: p.destination ?? null,
    txHash: p.rail_reference ?? null,
    failure: p.failure ?? null,
    createdAt: (p.created_at as Date).toISOString(),
  };
}
