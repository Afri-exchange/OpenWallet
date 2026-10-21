import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { CardTransaction } from "../cards/lifecycle.js";
import type { CardVault } from "../vault/vault.js";
import { AppError, SWAP_KEY_PREFIX, type AgentPrincipal, type ChargeOutcome, type Charger, type PayRequest, type SpendView } from "../app/service.js";
import { scrub, type CardDetails, type CheckoutFiller, type FillResult } from "./filler.js";

/**
 * Checkout swap: an agent pays a third-party hosted checkout (Stripe Checkout) and our server swaps in the
 * owner's real card. The agent sends a URL and the price it agreed to; it never sees the card.
 *
 *   validate (host allowlist, hard cap) -> AppService.pay under checkout:swap:<id>  (limits, balance, ledger debit)
 *     -> charge: vault.reveal (audited, purpose checkout:<id>) -> filler checks the page total, types the card, pays
 *     -> details scrubbed in a finally, whatever happened
 *
 * Charge outcomes: the page confirmed -> approved. Nothing was submitted, or the page showed a decline -> refused
 * (the debit is undone). Submitted with no clear answer (3-D Secure, a bot check after submit, timeout) -> unknown:
 * the money stays held and reconcile() matches the card's own Authorization by amount and time (a real checkout's
 * merchant id is the acquirer's, so it cannot tell payments apart). Two open swaps that could own one Authorization go
 * to a person rather than guessing. A challenge is never
 * retried automatically; a new attempt needs a new idempotency key from the agent.
 */

export interface SwapConfig {
  /** Off unless switched on (SWAP_ENABLED=1). */
  enabled: boolean;
  /** Hard cap per swap in cents. $10 until the live test passes. */
  maxAmountCents: number;
  /** Exact hosts allowed (https). Default: checkout.stripe.com and buy.stripe.com. */
  allowedHosts: string[];
  /** Hosts allowed over plain http (local fixture only). */
  insecureHosts?: string[];
  /** Receipt email typed into the page when the owner's email cannot be used. */
  fallbackEmail?: string;
}

export interface SwapDeps {
  pool: pg.Pool;
  app: {
    pay(p: AgentPrincipal, req: PayRequest, opts: { internal: true; charge: Charger }): Promise<SpendView>;
    resolveSwapSpend(spendId: string, out: { status: "approved"; auth?: string } | { status: "voided"; reason: string }): Promise<boolean>;
    noteSpend(spendId: string, reason: string): Promise<void>;
  };
  vault: Pick<CardVault, "reveal" | "has">;
  filler: CheckoutFiller;
  lifecycle: { transactions(cardId: string, type?: string, pageSize?: number): Promise<CardTransaction[]> };
  config: SwapConfig;
  now?: () => Date;
  log?: (msg: string) => void;
}

export type SwapStatus = "pending" | "filling" | "processing" | "paid" | "failed" | "challenge" | "needs_review";

export interface SwapRequest {
  checkoutUrl: string;
  /** The price the agent agreed to; the page total must match exactly or nothing is typed. */
  amountCents: number;
  merchant: string;
  mcc?: string;
  /** Required: same key + same swap = the same result, never a second payment. */
  idempotencyKey: string;
}

export interface SwapView {
  swapId: string;
  status: SwapStatus;
  amountCents: number;
  currency: "USD";
  merchant: string;
  checkoutHost: string;
  /** What the checkout page did (succeeded, declined, amount_mismatch, captcha, three_ds, unsupported_page, error). */
  outcome: string | null;
  detail: string | null;
  payment: { paymentId: string; status: SpendView["status"]; reason: string | null } | null;
  /** Set when a person is looking at this payment (e.g. the card network saw a different merchant category). */
  underReview: string | null;
  createdAt: string;
}

export const DEFAULT_SWAP_CAP_CENTS = 1_000;
/** Stripe Checkout sessions and Stripe Payment Links. */
export const DEFAULT_SWAP_HOSTS = ["checkout.stripe.com", "buy.stripe.com"];
/** A swap left open this long is checked against the card's transactions. */
const RECONCILE_AFTER_MS = 60_000;
/** After this long with no matching card transaction, a person must look (the money stays held). */
const GIVE_UP_AFTER_MS = 30 * 60_000;
/** A card Authorization this far before the swap started cannot be its charge (clock skew allowance). */
const MATCH_SKEW_MS = 2 * 60_000;

const newId = () => `sw_${randomBytes(12).toString("hex")}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function swapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SwapConfig {
  const cap = env.SWAP_MAX_CENTS === undefined ? DEFAULT_SWAP_CAP_CENTS : Number(env.SWAP_MAX_CENTS);
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("SWAP_MAX_CENTS must be a positive whole number of cents");
  const list = (v?: string) => (v ? v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) : []);
  return {
    enabled: env.SWAP_ENABLED === "1",
    maxAmountCents: cap,
    allowedHosts: env.SWAP_ALLOWED_HOSTS ? list(env.SWAP_ALLOWED_HOSTS) : DEFAULT_SWAP_HOSTS,
    insecureHosts: list(env.SWAP_INSECURE_HOSTS),
    fallbackEmail: env.SWAP_RECEIPT_EMAIL,
  };
}

export class SwapService {
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  /** One browser fill at a time in this process (one shared laptop, one Chromium). */
  private fillQueue: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, Promise<SwapView>>();
  private reconcileRun: Promise<void> | undefined;

  constructor(private readonly d: SwapDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
  }

  async pay(p: AgentPrincipal, req: SwapRequest): Promise<SwapView> {
    const r = this.validate(req);
    // Fail cleanly, before anything is reserved, when there is no card to swap in.
    if (!(await this.d.vault.has(p.cardId))) {
      throw new AppError(409, "this card's details are not on file, so it cannot pay hosted checkouts; the owner needs to have them captured again");
    }
    await this.insertOrBusy(p, r);
    const row = (await this.d.pool.query(
      "SELECT * FROM app_checkout_swap WHERE card_id = $1 AND agent_id = $2 AND idempotency_key = $3",
      [p.cardId, p.agentId, r.idempotencyKey],
    )).rows[0];
    if (row.checkout_url !== r.url.href || Number(row.amount_cents) !== r.amountCents || row.merchant !== r.merchant || (row.mcc ?? undefined) !== r.mcc) {
      throw new AppError(409, "that idempotency key was already used for a different checkout payment");
    }
    // Calling pay again under the same spend key never charges twice (AppService returns the first result),
    // so a pending row (crash, or a concurrent call) can always be driven forward safely.
    if (row.status !== "pending") return this.view(row);
    const swapId = row.swap_id as string;
    const inflight = this.running.get(swapId);
    if (inflight) return inflight;
    const run = this.drive(p, row).finally(() => this.running.delete(swapId));
    this.running.set(swapId, run);
    return run;
  }

  async get(p: AgentPrincipal, swapId: string): Promise<SwapView> {
    const row = (await this.d.pool.query("SELECT * FROM app_checkout_swap WHERE swap_id = $1 AND card_id = $2 AND agent_id = $3", [swapId, p.cardId, p.agentId])).rows[0];
    if (!row) throw new AppError(404, "checkout payment not found");
    return this.view(row);
  }

  async list(p: AgentPrincipal, limit = 20): Promise<SwapView[]> {
    const rows = (await this.d.pool.query(
      "SELECT * FROM app_checkout_swap WHERE card_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3",
      [p.cardId, p.agentId, Math.min(Math.max(limit, 1), 100)],
    )).rows;
    return Promise.all(rows.map((r) => this.view(r)));
  }

  private validate(req: SwapRequest): { url: URL; amountCents: number; merchant: string; mcc?: string; idempotencyKey: string } {
    const c = this.d.config;
    if (!c.enabled) throw new AppError(403, "paying hosted checkouts is not enabled on this server");
    const amountCents = req.amountCents;
    if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AppError(400, "amount must be a positive whole number of cents");
    if (amountCents > c.maxAmountCents) throw new AppError(400, `hosted checkout payments are capped at ${usd(c.maxAmountCents)} for now`);
    if (typeof req.merchant !== "string" || !req.merchant.trim() || req.merchant.length > 80) throw new AppError(400, "merchant is required (at most 80 characters)");
    const mcc = req.mcc === undefined || req.mcc === null || req.mcc === "" ? undefined : String(req.mcc);
    if (mcc !== undefined && !/^\d{4}$/.test(mcc)) throw new AppError(400, "mcc must be 4 digits");
    if (typeof req.idempotencyKey !== "string" || !req.idempotencyKey.trim() || req.idempotencyKey.length > 100) {
      throw new AppError(400, "idempotencyKey is required: a checkout payment must never be sent twice by accident");
    }
    let url: URL;
    try {
      url = new URL(String(req.checkoutUrl));
    } catch {
      throw new AppError(400, "checkoutUrl is not a valid URL");
    }
    const host = url.host.toLowerCase();
    const secureOk = url.protocol === "https:" && c.allowedHosts.includes(host);
    const insecureOk = url.protocol === "http:" && (c.insecureHosts ?? []).includes(host);
    if (!secureOk && !insecureOk) throw new AppError(400, `checkout host ${host} is not supported (allowed: ${c.allowedHosts.join(", ")})`);
    if (url.username || url.password) throw new AppError(400, "checkoutUrl must not contain credentials");
    return { url, amountCents, merchant: req.merchant.trim(), mcc, idempotencyKey: req.idempotencyKey.trim() };
  }

  private async drive(p: AgentPrincipal, row: Record<string, any>): Promise<SwapView> {
    const swapId = row.swap_id as string;
    const amountCents = Number(row.amount_cents);
    let fill: FillResult | undefined;
    const charge: Charger = (spendId) => this.serialized(async (): Promise<ChargeOutcome> => {
      await this.d.pool.query("UPDATE app_checkout_swap SET status = 'filling', spend_id = $2, updated_at = now() WHERE swap_id = $1", [swapId, spendId]);
      let card: CardDetails | null = null;
      try {
        // As late as possible: after the debit, right before the page.
        card = await this.d.vault.reveal(p.cardId, `checkout:${swapId}`);
        if (!card) {
          fill = { outcome: "error", submitted: false, detail: "card details not on file" };
          return { kind: "refused", reason: "this card's details are not on file; nothing was charged" };
        }
        fill = await this.d.filler.fill({ url: row.checkout_url, expectedAmountCents: amountCents, card, email: await this.receiptEmail(p) });
      } catch (e) {
        // The filler reports its own errors; this is the vault or something unexpected, before any submit.
        fill = { outcome: "error", submitted: false, detail: errText(e).slice(0, 200) };
        return { kind: "refused", reason: "could not start the checkout; nothing was charged" };
      } finally {
        scrub(card);
        card = null;
      }
      await this.d.pool.query(
        "UPDATE app_checkout_swap SET outcome = $2, detail = $3, submitted = $4, updated_at = now() WHERE swap_id = $1",
        [swapId, fill.outcome, fill.detail ?? null, fill.submitted],
      );
      this.log(`swap ${swapId}: ${fill.outcome}${fill.submitted ? " (submitted)" : ""}`);
      if (fill.outcome === "succeeded") return { kind: "approved" };
      if (fill.outcome === "declined") return { kind: "refused", reason: "card declined at the checkout" };
      if (!fill.submitted) return { kind: "refused", reason: refusedReason(fill) };
      return { kind: "unknown", reason: "the checkout gave no clear answer after the card was submitted; the money is held while we check the card" };
    });

    let spend: SpendView;
    try {
      spend = await this.d.app.pay(p, { amountCents, merchant: row.merchant, mcc: row.mcc ?? undefined, idempotencyKey: `${SWAP_KEY_PREFIX}${swapId}` }, { internal: true, charge });
    } catch (e) {
      // Nothing was reserved (a 4xx from pay), so this attempt is over.
      await this.d.pool.query("UPDATE app_checkout_swap SET status = 'failed', detail = $2, updated_at = now() WHERE swap_id = $1 AND status IN ('pending', 'filling')", [swapId, errText(e).slice(0, 200)]);
      throw e;
    }
    const status: SwapStatus =
      spend.status === "approved" ? "paid"
      : fill && (fill.outcome === "captcha" || fill.outcome === "three_ds") ? "challenge"
      : spend.status === "processing" ? "processing"
      : "failed";
    const detail = fill ? undefined : spend.reason ?? undefined;
    const updated = (await this.d.pool.query(
      "UPDATE app_checkout_swap SET status = $2, spend_id = $3, detail = COALESCE($4, detail), updated_at = now() WHERE swap_id = $1 RETURNING *",
      [swapId, status, spend.spendId, detail ?? null],
    )).rows[0];
    return this.view(updated);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.fillQueue.then(fn, fn);
    this.fillQueue = run.catch(() => undefined);
    return run;
  }

  private async receiptEmail(p: AgentPrincipal): Promise<string> {
    const r = await this.d.pool.query("SELECT u.email FROM app_card c JOIN app_user u ON u.id = c.user_id WHERE c.card_id = $1", [p.cardId]);
    const email = r.rows[0]?.email ?? this.d.config.fallbackEmail;
    if (!email) throw new Error("no receipt email for this card");
    return email;
  }

  /**
   * Settles swaps whose charge state was unknown (3-D Secure, timeout, crash) from the card's Authorization list:
   * exactly one unclaimed Authorization of the same amount, from the swap's start onwards. Ambiguity or silence past
   * GIVE_UP_AFTER_MS goes to a person (needs_review); money is never refunded on absence of evidence.
   */
  reconcile(): Promise<void> {
    this.reconcileRun ??= this.doReconcile().finally(() => (this.reconcileRun = undefined));
    return this.reconcileRun;
  }

  private async doReconcile(): Promise<void> {
    const before = new Date(this.now().getTime() - RECONCILE_AFTER_MS);
    // A challenge is open only while its money is held; one whose spend was voided (stopped before submit) is final.
    const rows = (await this.d.pool.query(
      `SELECT s.* FROM app_checkout_swap s LEFT JOIN app_spend p ON p.spend_id = s.spend_id
       WHERE (s.status IN ('pending', 'filling', 'processing') OR (s.status = 'challenge' AND p.status = 'processing')) AND s.updated_at < $1
       ORDER BY s.created_at LIMIT 100`,
      [before],
    )).rows;
    const lists = new Map<string, Promise<CardTransaction[]>>();
    for (const s of rows) {
      if (this.running.has(s.swap_id)) continue;
      await this.reconcileOne(s, lists).catch((e) => this.log(`swap reconcile ${s.swap_id}: ${errText(e)}`));
    }
    // Paid on the page: confirm on the card, and learn the real merchant category.
    const paid = (await this.d.pool.query(
      "SELECT * FROM app_checkout_swap WHERE status = 'paid' AND card_txn_ref IS NULL AND review IS NULL AND updated_at < $1 ORDER BY created_at LIMIT 100",
      [before],
    )).rows;
    for (const s of paid) await this.confirmPaid(s, lists).catch((e) => this.log(`swap confirm ${s.swap_id}: ${errText(e)}`));
  }

  /** Unclaimed Authorizations on the swap's card that could be its charge: same amount, not before it started. */
  private async candidates(s: Record<string, any>, lists: Map<string, Promise<CardTransaction[]>>): Promise<CardTransaction[]> {
    if (!lists.has(s.card_id)) lists.set(s.card_id, this.d.lifecycle.transactions(s.card_id, "Authorization", 100));
    const claimed = new Set((await this.d.pool.query("SELECT card_txn_ref FROM app_checkout_swap WHERE card_id = $1 AND card_txn_ref IS NOT NULL", [s.card_id])).rows.map((r) => r.card_txn_ref));
    const from = new Date(s.created_at).getTime() - MATCH_SKEW_MS;
    const amount = Number(s.amount_cents);
    return (await lists.get(s.card_id)!).filter((t) => {
      const ref = txnRef(t);
      const at = parseCardTime(t.transactionTime);
      return ref !== undefined && !claimed.has(ref) && Math.round((t.transactionAmount ?? NaN) * 100) === amount && at !== undefined && at >= from;
    });
  }

  /**
   * Writes the swap row, unless another swap of the same amount on the same card is still in flight: reconcile could
   * not tell their card authorizations apart (see hasRival), so the agent waits a minute instead. A retry under an
   * existing key is never refused. The advisory lock makes check-and-insert atomic per card and amount.
   */
  private async insertOrBusy(p: AgentPrincipal, r: ReturnType<SwapService["validate"]>): Promise<void> {
    const c = await this.d.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`swap:${p.cardId}:${r.amountCents}`]);
      const busy = (await c.query(
        `SELECT 1 FROM app_checkout_swap x LEFT JOIN app_spend s ON s.spend_id = x.spend_id
         WHERE x.card_id = $1 AND x.amount_cents = $2 AND NOT (x.agent_id = $3 AND x.idempotency_key = $4)
           AND x.created_at >= $5
           AND (x.status IN ('pending', 'filling', 'processing')
             OR (x.status = 'challenge' AND s.status = 'processing')
             OR (x.status = 'paid' AND x.card_txn_ref IS NULL AND x.review IS NULL))
           AND NOT EXISTS (SELECT 1 FROM app_checkout_swap k WHERE k.card_id = $1 AND k.agent_id = $3 AND k.idempotency_key = $4)
         LIMIT 1`,
        [p.cardId, r.amountCents, p.agentId, r.idempotencyKey, new Date(this.now().getTime() - GIVE_UP_AFTER_MS)],
      )).rowCount;
      if (busy) {
        throw new AppError(409, `another ${usd(r.amountCents)} checkout payment on this card is still being confirmed; nothing was charged. Try again in a minute`);
      }
      await c.query(
        `INSERT INTO app_checkout_swap (swap_id, card_id, agent_id, idempotency_key, checkout_url, checkout_host, amount_cents, merchant, mcc, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') ON CONFLICT (card_id, agent_id, idempotency_key) DO NOTHING`,
        [newId(), p.cardId, p.agentId, r.idempotencyKey, r.url.href, r.url.host, r.amountCents, r.merchant, r.mcc ?? null],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Another unsettled swap on the same card, for the same amount, that a card transaction at `at` could also belong
   * to. A real checkout's merchant id is the acquirer's, the same for every payment to that merchant, so amount and
   * time are all we can match on; when two swaps fit, neither settles on its own.
   */
  private async hasRival(s: Record<string, any>, at: number | undefined): Promise<boolean> {
    if (at === undefined) return true;
    const r = await this.d.pool.query(
      `SELECT 1 FROM app_checkout_swap x LEFT JOIN app_spend p ON p.spend_id = x.spend_id
       WHERE x.card_id = $1 AND x.swap_id <> $2 AND x.amount_cents = $3 AND x.card_txn_ref IS NULL
         AND (x.status IN ('pending', 'filling', 'processing', 'paid', 'needs_review') OR (x.status = 'challenge' AND p.status = 'processing'))
         AND x.created_at <= $4 AND x.created_at >= $5 LIMIT 1`,
      [s.card_id, s.swap_id, s.amount_cents, new Date(at + MATCH_SKEW_MS), new Date(at - GIVE_UP_AFTER_MS)],
    );
    return r.rowCount! > 0;
  }

  /** Claims a card transaction for a swap (unique: one transaction settles one swap) and records its MCC. */
  private async claim(s: Record<string, any>, t: CardTransaction): Promise<boolean> {
    const note = mccReview(s.mcc, t.merchantMcc);
    const r = await this.d.pool.query(
      "UPDATE app_checkout_swap SET card_txn_ref = $2, card_mcc = $3, review = COALESCE(review, $4), updated_at = now() WHERE swap_id = $1 AND card_txn_ref IS NULL",
      [s.swap_id, txnRef(t), t.merchantMcc ?? null, note],
    ).catch(() => ({ rowCount: 0 }));
    if (r.rowCount === 1 && note) this.log(`swap ${s.swap_id}: ${note}`);
    return r.rowCount === 1;
  }

  private async confirmPaid(s: Record<string, any>, lists: Map<string, Promise<CardTransaction[]>>): Promise<void> {
    const approved = (await this.candidates(s, lists)).filter((t) => /^(approved|successful|settled)$/i.test(t.transactionStatus ?? ""));
    const review = (note: string) => {
      this.log(`swap ${s.swap_id}: ${note}`);
      return this.d.pool.query("UPDATE app_checkout_swap SET review = $2, updated_at = now() WHERE swap_id = $1 AND review IS NULL", [s.swap_id, note]);
    };
    if (approved.length === 1) {
      if (await this.hasRival(s, parseCardTime(approved[0]!.transactionTime))) return void (await review("another open payment of the same amount on this card could own the card authorization"));
      return void (await this.claim(s, approved[0]!));
    }
    if (approved.length > 1) return void (await review(`${approved.length} card authorizations could be this payment`));
    if (this.now().getTime() - new Date(s.created_at).getTime() > GIVE_UP_AFTER_MS) {
      await review("the checkout page said paid, but the card shows no matching authorization");
    }
  }

  private async reconcileOne(s: Record<string, any>, lists: Map<string, Promise<CardTransaction[]>>): Promise<void> {
    const swapId = s.swap_id as string;
    const set = (status: SwapStatus, detail?: string) =>
      this.d.pool.query("UPDATE app_checkout_swap SET status = $2, detail = COALESCE($3, detail), updated_at = now() WHERE swap_id = $1", [swapId, status, detail ?? null]);
    const spend = (await this.d.pool.query("SELECT * FROM app_spend WHERE card_id = $1 AND agent_id = $2 AND idempotency_key = $3", [s.card_id, s.agent_id, `${SWAP_KEY_PREFIX}${swapId}`])).rows[0];
    if (!spend) {
      // No spend row: pay never got as far as reserving, so nothing can have been charged.
      await set("failed", "interrupted before payment; nothing was charged");
      return;
    }
    if (spend.status === "approved") return void (await set("paid"));
    if (spend.status === "declined" || spend.status === "voided") return void (await set(s.status === "challenge" ? "challenge" : "failed"));

    const candidates = await this.candidates(s, lists);
    const amount = Number(s.amount_cents);
    const age = this.now().getTime() - new Date(s.created_at).getTime();
    if (candidates.length > 1) {
      const note = `needs review: ${candidates.length} card authorizations of ${usd(amount)} could be this payment; the money is held`;
      await set("needs_review", note);
      await this.d.app.noteSpend(spend.spend_id, note);
      this.log(`swap ${swapId}: ${note}`);
      return;
    }
    const t = candidates[0];
    if (!t) {
      if (age > GIVE_UP_AFTER_MS) {
        const note = "needs review: the card shows no authorization for this payment yet; the money is held";
        await set("needs_review", note);
        await this.d.app.noteSpend(spend.spend_id, note);
        this.log(`swap ${swapId}: ${note}`);
      }
      return;
    }
    if (await this.hasRival(s, parseCardTime(t.transactionTime))) {
      const note = `needs review: another open payment of ${usd(amount)} on this card could own the card authorization; the money is held`;
      await set("needs_review", note);
      await this.d.app.noteSpend(spend.spend_id, note);
      this.log(`swap ${swapId}: ${note}`);
      return;
    }
    const status = t.transactionStatus ?? "";
    if (/^(approved|successful|settled)$/i.test(status)) {
      // Claim first (unique), so one authorization can never settle two swaps.
      if (!(await this.claim(s, t))) return;
      await this.d.app.resolveSwapSpend(spend.spend_id, { status: "approved", auth: t.authCode });
      await set("paid", "confirmed on the card");
      this.log(`swap ${swapId}: approved on the card`);
    } else if (/^(declined|failed|reversed)$/i.test(status)) {
      await this.claim(s, t);
      await this.d.app.resolveSwapSpend(spend.spend_id, { status: "voided", reason: `card declined (${status})` });
      await set(s.status === "challenge" ? "challenge" : "failed", `card declined (${status})`);
    } else if (age > GIVE_UP_AFTER_MS) {
      const note = `needs review: the card shows status "${status}"; the money is held`;
      await set("needs_review", note);
      await this.d.app.noteSpend(spend.spend_id, note);
    }
  }

  private async view(row: Record<string, any>): Promise<SwapView> {
    const spend = row.spend_id
      ? (await this.d.pool.query("SELECT spend_id, status, reason FROM app_spend WHERE spend_id = $1", [row.spend_id])).rows[0]
      : undefined;
    return {
      swapId: row.swap_id,
      status: row.status,
      amountCents: Number(row.amount_cents),
      currency: "USD",
      merchant: row.merchant,
      checkoutHost: row.checkout_host,
      outcome: row.outcome ?? null,
      detail: row.detail ?? null,
      payment: spend ? { paymentId: spend.spend_id, status: spend.status, reason: spend.reason ?? null } : null,
      underReview: row.review ?? null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
}

function refusedReason(f: FillResult): string {
  switch (f.outcome) {
    case "amount_mismatch": return `the checkout's price is not what you agreed to (${f.detail ?? "different total"}); nothing was charged`;
    case "captcha": return "the checkout showed a bot check, so we stopped; nothing was charged. It will not be retried automatically";
    case "unsupported_page": return `this checkout page is not supported (${f.detail ?? "no card form"}); nothing was charged`;
    default: return `the checkout could not be completed (${f.detail ?? f.outcome}); nothing was charged`;
  }
}

/** A review note when the agent declared one merchant category and the card network saw another. */
const mccReview = (declared: string | null, seen: string | undefined) =>
  declared && seen && declared !== seen ? `merchant category mismatch: declared ${declared}, card network saw ${seen}` : null;

const txnRef = (t: CardTransaction) => t.transactionReference ?? (t.id === undefined ? undefined : String(t.id));

/** Miden shows UTC without a zone suffix ("2026-10-19T14:11:54.689346"). */
export function parseCardTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}
