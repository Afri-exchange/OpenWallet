import { createHash, randomBytes } from "node:crypto";
import type { CheckoutRepository } from "../../domain/repositories/CheckoutRepository.js";
import type { MerchantRepository } from "../../domain/repositories/MerchantRepository.js";
import type { PayoutRepository } from "../../domain/repositories/PayoutRepository.js";
import type { Checkout, Merchant, Payout, Spend } from "../../domain/types/Entities.js";
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
  merchants: MerchantRepository;
  checkouts: CheckoutRepository;
  payouts: PayoutRepository;
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
    const created = await this.d.merchants.create({ merchantId, name, email, mcc: mcc ?? null, keyHash: hashKey(secretKey) });
    if (!created) throw conflictError("that email already has a merchant account");
    return { merchantId, name, secretKey };
  }

  merchantByKey(key: string): Promise<string | undefined> {
    return this.d.merchants.findIdByKeyHash(hashKey(key));
  }

  /** Replaces the merchant's secret key; the old one stops working at once. */
  async rotateMerchantKey(merchantId: string): Promise<{ secretKey: string }> {
    const secretKey = `mk_${randomBytes(32).toString("base64url")}`;
    await this.d.merchants.updateKeyHash(merchantId, hashKey(secretKey));
    return { secretKey };
  }

  async merchantProfile(merchantId: string): Promise<MerchantProfile> {
    const m = await this.merchant(merchantId);
    return { merchantId, name: m.name, email: m.email, mcc: m.mcc, payoutAddress: m.payoutAddress, payoutAddressUsableFrom: this.usableFrom(m)?.toISOString() ?? null };
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
    await this.d.merchants.setPayoutAddress(merchantId, address, this.now());
    this.log(`merchant ${merchantId}: payout address set to ${address}`);
    return this.merchantProfile(merchantId);
  }

  private usableFrom(m: Merchant): Date | undefined {
    if (!m.payoutAddressSetAt) return undefined;
    return new Date(m.payoutAddressSetAt.getTime() + (this.d.payoutAddressDelayMs ?? DEFAULT_PAYOUT_ADDRESS_DELAY_MS));
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
      const prior = await this.d.payouts.findByIdempotencyKey(merchantId, key);
      if (prior) {
        if (prior.amountCents !== amountCents) throw conflictError("that idempotency key was already used for a different payout");
        return payoutRow(prior);
      }
    }
    if (!m.payoutAddress) throw conflictError("set a payout address first (POST /merchant/v1/payout-address)");
    const from = this.usableFrom(m)!;
    if (this.now() < from) throw conflictError(`your payout address was changed recently; payouts to it are allowed from ${from.toISOString()}`);
    const payoutId = `po_${randomBytes(12).toString("hex")}`;
    // The row first, so a crash after the reservation leaves a payout ops can see.
    const created = await this.d.payouts.createRequested({
      payoutId, merchantId, amountCents, idempotencyKey: key ?? null, destination: m.payoutAddress, chain: PAYOUT_CHAIN,
    });
    if (!created) {
      // The same key, requested concurrently: answer from that payout.
      if (key) return this.requestPayout(merchantId, body);
      throw new Error(`payout ${payoutId}: unique constraint hit without an idempotency key`);
    }
    try {
      await this.d.ledger.reservePayout({ merchantId, amountCents, payoutId });
    } catch (e) {
      // Failed only if nothing was reserved; a reservation that committed before the error stands.
      if (!(await this.d.ledger.findByKey(`payout-reserve:${payoutId}`))) {
        const short = e instanceof LedgerError && /insufficient/.test(e.message);
        await this.d.payouts.failRequested(payoutId, short ? "insufficient balance" : "could not reserve funds");
        if (short) throw conflictError("payout is more than the available balance");
      }
      throw e;
    }
    this.log(`payout ${payoutId}: ${amountCents}c reserved for ${merchantId}, to ${m.payoutAddress}`);
    return payoutRow((await this.d.payouts.find(payoutId))!);
  }

  async listPayouts(merchantId: string, limit = 20): Promise<PayoutView[]> {
    return (await this.d.payouts.listByMerchant(merchantId, Math.min(Math.max(1, limit), 100))).map(payoutRow);
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
    const p = await this.d.payouts.find(payoutId);
    if (!p) throw notFoundError("payout not found");
    const target = outcome.sent ? "sent" : "failed";
    const args = { merchantId: p.merchantId, amountCents: p.amountCents, payoutId };
    const reserved = !!(await this.d.ledger.findByKey(`payout-reserve:${payoutId}`));
    if (outcome.sent && !reserved) throw conflictError("no funds are reserved for this payout");
    // Claim the row BEFORE moving money, so ops and the sender can never both act on it: whoever claims first
    // wins. Ops may only settle a payout nothing has been broadcast for. A broadcast transfer may still be mined,
    // so only the chain's answer (fromRail) settles it, or a person after review (afterReview, needs_review set).
    const from = opts.fromRail ? "sending" : opts.afterReview ? "sending-under-review" : "requested";
    const claimed = await this.d.payouts.claimSettlement(
      payoutId,
      from,
      outcome.sent ? { sent: true, ...(outcome.railReference != null ? { railReference: outcome.railReference } : {}) } : { sent: false, failure: outcome.failure.slice(0, 300) },
    );
    if (!claimed) {
      const now = await this.d.payouts.find(payoutId);
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
    return payoutRow((await this.d.payouts.find(payoutId))!);
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
    const same = (c: Checkout) =>
      c.amountCents === amountCents && c.description === description && (c.reference ?? undefined) === reference && (c.mcc ?? undefined) === mcc;
    if (key) {
      const prior = await this.d.checkouts.findByIdempotencyKey(merchantId, key);
      if (prior) {
        if (!same(prior)) throw conflictError("that idempotency key was already used for a different checkout");
        return this.merchantView(prior);
      }
    }
    const checkoutId = `cs_${randomBytes(16).toString("hex")}`;
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);
    const created = await this.d.checkouts.createOpen({
      checkoutId, merchantId, amountCents, description, reference: reference ?? null, mcc: mcc ?? null, metadata, idempotencyKey: key ?? null, expiresAt,
    });
    if (created) return this.merchantView(created);
    if (!key) throw new Error(`checkout ${checkoutId}: unique constraint hit without an idempotency key`);
    // The same key, created concurrently.
    const prior = await this.d.checkouts.findByIdempotencyKey(merchantId, key);
    if (prior && same(prior)) return this.merchantView(prior);
    throw conflictError("that idempotency key was already used for a different checkout");
  }

  async getForMerchant(merchantId: string, checkoutId: string): Promise<MerchantCheckoutView> {
    await this.syncOne(checkoutId);
    const c = await this.d.checkouts.find(checkoutId);
    if (!c || c.merchantId !== merchantId) throw notFoundError("checkout not found");
    return this.merchantView(c);
  }

  async list(merchantId: string, limit = 20): Promise<MerchantCheckoutView[]> {
    await this.expire();
    const rows = await this.d.checkouts.listByMerchant(merchantId, Math.min(Math.max(1, limit), 100));
    return Promise.all(rows.map((c) => this.merchantView(c)));
  }

  /** Only an open checkout can be canceled; one being paid or paid cannot. */
  async cancel(merchantId: string, checkoutId: string): Promise<MerchantCheckoutView> {
    await this.expire();
    const canceled = await this.d.checkouts.cancelIfOpen(checkoutId, merchantId);
    if (canceled) return this.merchantView(canceled);
    const c = await this.d.checkouts.find(checkoutId);
    if (!c || c.merchantId !== merchantId) throw notFoundError("checkout not found");
    if (c.status === "canceled") return this.merchantView(c);
    throw conflictError(`checkout is ${c.status} and cannot be canceled`);
  }

  // ---------- checkouts (public / agent side) ----------

  async getPublic(checkoutId: string): Promise<PublicCheckoutView> {
    await this.syncOne(checkoutId);
    const c = await this.d.checkouts.find(checkoutId);
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
    const mine = (c: Checkout) => c.cardId === p.cardId && c.agentId === p.agentId;
    let c = await this.d.checkouts.find(checkoutId);
    if (c && maxAmountCents !== undefined && c.amountCents > maxAmountCents) {
      throw conflictError(`checkout costs ${c.amountCents} cents, more than the ${maxAmountCents} you allowed; nothing was charged`);
    }
    // Two rounds at most: a lost claim race re-reads the row once and then answers from its state.
    for (let round = 0; ; round++) {
      if (!c) throw notFoundError("checkout not found");
      if (c.status === "paid") {
        if (!mine(c)) throw conflictError("this checkout was already paid");
        return { checkout: await this.publicView(c), payment: await this.spendOf(c.spendId!) };
      }
      if (c.status === "canceled" || c.status === "expired") throw goneError(`checkout is ${c.status}`);
      if (c.status === "processing") {
        if (!mine(c)) throw conflictError("another agent is paying this checkout");
        break; // resume this agent's attempt: pay() returns the existing payment for its key
      }
      const claimed = await this.d.checkouts.claim(checkoutId, { cardId: p.cardId, agentId: p.agentId }, this.now());
      if (claimed) {
        c = claimed;
        break;
      }
      if (round > 0) throw conflictError("checkout changed while paying; try again");
      await this.expire();
      c = await this.d.checkouts.find(checkoutId);
    }
    const checkout = c!;
    const merchant = await this.merchant(checkout.merchantId);
    const key = spendKey(checkoutId, checkout.attempt);
    let payment: SpendView;
    try {
      payment = await this.d.app.pay(p, {
        amountCents: checkout.amountCents,
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
    return { checkout: await this.publicView(after ?? (await this.d.checkouts.find(checkoutId))!), payment };
  }

  // ---------- settling ----------

  /** Moves a claimed checkout to where its payment went. Guarded on the attempt, so a stale answer changes nothing. */
  private async apply(c: Checkout, s: SpendView, merchantName: string): Promise<Checkout | undefined> {
    const id = c.checkoutId;
    // Defence in depth: only a spend for exactly this checkout's price and merchant can pay it.
    if (s.amountCents !== c.amountCents || s.merchant !== merchantName) {
      const note = `needs review: payment ${s.spendId} (${s.amountCents}c to ${s.merchant}) does not match this checkout`;
      await this.d.checkouts.flagForReview(id, note, c.attempt);
      this.log(`checkout ${id}: ${note}`);
      return undefined;
    }
    if (s.status === "approved") {
      const paid = await this.d.checkouts.markPaid(id, c.attempt, s.spendId, this.now());
      if (!paid) {
        // A stalled claim was released and someone else paid: one item, two charges. Visible to the merchant and ops.
        const note = `needs review: payment ${s.spendId} (attempt ${c.attempt}) was approved after the checkout moved on`;
        await this.d.checkouts.flagForReview(id, note);
        this.log(`checkout ${id}: ${note}`);
        return undefined;
      }
      // Only the attempt that moved the checkout to paid credits the merchant. A failure here is retried by sync.
      try {
        return (await this.settle(paid)) ?? paid;
      } catch (e) {
        this.log(`checkout ${id}: settle: ${errText(e)}`);
        return paid;
      }
    }
    if (s.status === "processing") return this.d.checkouts.attachSpend(id, c.attempt, s.spendId);
    return this.release(id, c.attempt, s.reason ?? s.status);
  }

  /** Credits the merchant for a paid checkout. Idempotent: the ledger key is per checkout. */
  private async settle(c: Checkout): Promise<Checkout | undefined> {
    const tx = await this.d.ledger.settleCheckout({ merchantId: c.merchantId, checkoutId: c.checkoutId, amountCents: c.amountCents });
    return this.d.checkouts.recordSettlement(c.checkoutId, tx.seq);
  }

  private release(checkoutId: string, attempt: number, why: string): Promise<Checkout | undefined> {
    return this.d.checkouts.release(checkoutId, attempt, why.slice(0, 300));
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
    for (const id of await this.d.checkouts.findProcessingIds(200)) await this.syncOne(id).catch((e) => this.log(`checkout ${id}: sync: ${errText(e)}`));
    // Paid but not yet credited to the merchant (a crash or error between the two).
    for (const c of await this.d.checkouts.findUnsettled(200)) await this.settle(c).catch((e) => this.log(`checkout ${c.checkoutId}: settle: ${errText(e)}`));
    await this.finishPayouts();
  }

  /**
   * A payout row claimed sent/failed whose ledger step (complete/release) never landed (it threw, or we crashed)
   * keeps its money in payout_pending. Re-run settlePayout with the row's own outcome: idempotent by ledger key.
   * Only rows with a reservation and no closing entry are touched.
   */
  private async finishPayouts(): Promise<void> {
    for (const p of await this.d.payouts.findUnfinishedSettlements(100)) {
      const outcome = p.status === "sent"
        ? ({ sent: true, railReference: p.railReference ?? undefined } as const)
        : ({ sent: false, failure: p.failure ?? "payout failed" } as const);
      await this.settlePayout(p.payoutId, outcome).catch((e) => this.log(`payout ${p.payoutId}: finish: ${errText(e)}`));
    }
  }

  private async syncOne(checkoutId: string): Promise<void> {
    if (this.paying.has(checkoutId)) return;
    const c = await this.d.checkouts.find(checkoutId);
    if (!c || c.status !== "processing") return;
    // Processing always has an agent (CHECK app_checkout_check) and its card.
    const s = await this.spendByKey(c.cardId!, c.agentId!, spendKey(checkoutId, c.attempt));
    if (s) {
      await this.apply(c, s, (await this.merchant(c.merchantId)).name);
    } else if (this.now().getTime() - new Date(c.claimedAt!).getTime() > STALE_CLAIM_MS) {
      await this.release(checkoutId, c.attempt, "interrupted before payment; nothing was charged");
      this.log(`checkout ${checkoutId}: stale claim released`);
    }
  }

  /** Open checkouts past their time become expired. A processing one is left to finish. */
  private async expire(): Promise<void> {
    await this.d.checkouts.expireOpen(this.now());
  }

  // ---------- helpers ----------

  private async merchant(merchantId: string): Promise<Merchant> {
    const m = await this.d.merchants.find(merchantId);
    if (!m) throw notFoundError("merchant not found");
    return m;
  }

  private async spendByKey(cardId: string, agentId: string, key: string): Promise<SpendView | undefined> {
    const s = await this.d.checkouts.findSpendByKey(cardId, agentId, key);
    return s ? spendRow(s) : undefined;
  }

  private async spendOf(spendId: string): Promise<SpendView> {
    return spendRow((await this.d.checkouts.findSpend(spendId))!);
  }

  private async merchantView(c: Checkout): Promise<MerchantCheckoutView> {
    let payment: MerchantCheckoutView["payment"] = null;
    let underReview: string | null = c.needsReview ? "payment under review; do not fulfil" : null;
    if (c.spendId) {
      const s = await this.d.checkouts.findSpend(c.spendId);
      if (s) payment = { paymentId: c.spendId, status: s.status };
      if (s?.status === "processing" && /^needs review/.test(s.reason ?? "")) underReview ??= "payment under review: the card network has not confirmed it yet; do not fulfil";
    }
    return {
      checkoutId: c.checkoutId,
      status: c.status,
      amountCents: c.amountCents,
      currency: "USD",
      description: c.description,
      reference: c.reference,
      mcc: c.mcc,
      metadata: c.metadata,
      checkoutUrl: this.urlOf(c.checkoutId),
      expiresAt: c.expiresAt.toISOString(),
      paidAt: c.paidAt ? c.paidAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
      payment,
      lastAttempt: c.status === "open" && c.lastError ? "failed" : null,
      underReview,
    };
  }

  private async publicView(c: Checkout): Promise<PublicCheckoutView> {
    const m = await this.merchant(c.merchantId);
    return {
      checkoutId: c.checkoutId,
      merchant: m.name,
      description: c.description,
      amountCents: c.amountCents,
      currency: "USD",
      status: c.status,
      expiresAt: c.expiresAt.toISOString(),
    };
  }

  urlOf(checkoutId: string): string {
    return `${this.d.publicUrl.replace(/\/$/, "")}/pay/${checkoutId}`;
  }
}

function spendRow(s: Spend): SpendView {
  return {
    spendId: s.spendId,
    amountCents: s.amountCents,
    merchant: s.merchant,
    mcc: s.mcc ?? null,
    status: s.status,
    reason: s.reason ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function payoutRow(p: Payout): PayoutView {
  return {
    payoutId: p.payoutId,
    amountCents: p.amountCents,
    currency: "USD",
    status: p.status,
    chain: p.chain ?? null,
    destination: p.destination ?? null,
    txHash: p.railReference ?? null,
    failure: p.failure ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}
