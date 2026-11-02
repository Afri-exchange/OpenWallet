import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { AgentWallets } from "../agents/wallets.js";
import type { PgDepositAddresses } from "../chain/pg.js";
import { MidenBusinessError, type CardLifecycle, type CardTransaction } from "../cards/lifecycle.js";
import { evaluate, type SpendPolicy } from "../cards/policy.js";
import type { CardService } from "../cards/service.js";
import { capPolicy, type Tier, type TierLimits } from "../cards/tiers.js";
import { MidenDuplicateReferenceError, referenceFor } from "../funding/miden-wallet.js";
import type { FundingSource } from "../funding/types.js";
import { accounts, LedgerError, type Ledger, type LedgerTransaction } from "../ledger/ledger.js";
import { parseSimDeposit, SIM_DEPOSIT_PREFIX } from "../chain/sim-deposit.js";
import { MidenApiError, type MidenClient } from "../miden/client.js";
import type { IndividualKyc } from "../users/onboarding.js";

/** An error the HTTP layer may show to the caller as-is. */
export class AppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface AppDeps {
  pool: pg.Pool;
  ledger: Ledger;
  miden: MidenClient;
  lifecycle: CardLifecycle;
  cards: Pick<CardService, "issue" | "issueOneTime">;
  funding: FundingSource;
  wallets: AgentWallets;
  addresses: PgDepositAddresses;
  /**
   * The deposit-address provider: the address for a unique index. Our HD wallet today (sync); a custody
   * provider such as Utila would call its API here (hence async), keyed by the same index.
   */
  deriveAddress: (index: number) => string | Promise<string>;
  tiers: Record<Tier, TierLimits>;
  /** Ledger chain label for real deposits, e.g. "base-sepolia". */
  chain: string;
  /** Networks a user may send USDC on, shown on the dashboard. Default: the chain plus Ethereum Sepolia (both watched). */
  depositNetworks?: string[];
  /** How deposits are detected, for the dashboard's wording: Circle webhooks or our chain pollers. */
  depositRail?: "circle" | "chain";
  /** Miden sandbox: agents pay through Miden's simulated authorization. */
  sandbox: boolean;
  /** Sandbox only, and only when explicitly switched on (ALLOW_SIMULATED_DEPOSITS=1): fake deposits. */
  simulatedDeposits?: boolean;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Told about things a developer may want a webhook for (kyc.updated, card.issued, funding.completed, spend.settled). Never throws into the money path. */
  onEvent?: (userId: string, type: string, data: Record<string, unknown>) => Promise<void>;
}

export interface AgentPrincipal {
  cardId: string;
  agentId: string;
  name: string;
  userId: string;
}

export interface PayRequest {
  amountCents: number;
  merchant: string;
  mcc?: string;
  /** Same key + same payment = the same result, never a second charge. */
  idempotencyKey?: string;
}

export interface SpendView {
  spendId: string;
  amountCents: number;
  merchant: string;
  mcc: string | null;
  status: "processing" | "approved" | "declined" | "voided";
  reason: string | null;
  createdAt: string;
}

/** Miden's minimum useful top-up for us; smaller holding balances wait for more deposits. */
const MIN_FUNDING_CENTS = 100;
const ONE_TIME_MIN_CENTS = 100;
const ONE_TIME_MAX_PER_DAY = 50;
/** A payment still unanswered this long after it started is checked against the card's transactions. */
const RECONCILE_AFTER_MS = 60_000;
/** A payment the card network has no record of after this long is flagged for review (never refunded automatically). */
const GIVE_UP_AFTER_MS = 10 * 60_000;
/** Miden's Reference idempotency lasts 24h: past this, a reserved top-up is looked up, never re-sent. */
const RESEND_WINDOW_MS = 20 * 3_600_000;
/** Spend keys reserved for checkout payments; agents cannot use them. */
export const INTERNAL_KEY_PREFIX = "checkout:";
/** Spend keys of checkout-swap payments (src/checkout-swap): charged by filling a hosted checkout, reconciled by SwapService. */
export const SWAP_KEY_PREFIX = "checkout:swap:";

/**
 * How an internal caller charges the card instead of Miden's simulated authorization. Called once, after the
 * agent's limits passed and its money is debited. "refused" means nothing was charged (the debit is undone);
 * "unknown" means we cannot tell (the money stays held and the caller's own reconcile settles it via resolveSpend).
 */
export type ChargeOutcome = { kind: "approved"; auth?: string } | { kind: "refused"; reason: string } | { kind: "unknown"; reason: string };
export type Charger = (spendId: string) => Promise<ChargeOutcome>;
const ID_TYPES = new Set(["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE", "VOTERS_CARD"]);

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newId = (prefix: string, bytes = 6) => `${prefix}_${randomBytes(bytes).toString("hex")}`;
const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const num = (v: string | number | null) => (v === null ? 0 : Number(v));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/**
 * Per-spend merchant id for Miden's simulated authorization. It comes back as `merchantMid` on the card's
 * Authorization transaction, so a payment whose answer was lost can be found exactly.
 */
export const midFor = (spendId: string) => `9${(BigInt(`0x${createHash("sha256").update(spendId).digest("hex").slice(0, 15)}`) % 10n ** 14n).toString().padStart(14, "0")}`;

function requireCents(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new AppError(400, `${what} must be a positive whole number of cents`);
  return v;
}

function requireText(v: unknown, what: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new AppError(400, `${what} is required`);
  if (v.length > max) throw new AppError(400, `${what} is too long`);
  return v.trim();
}

/**
 * The sandbox service: a user signs up, passes Miden Card KYC, gets one card and a USDC deposit address;
 * deposits are credited by the chain watcher and moved onto the card; the user hands money and limits to
 * agents, and agents pay through `pay` (REST or MCP). All money movements go through the ledger.
 */
export class AppService {
  private readonly issuing = new Map<string, Promise<void>>();
  private readonly paying = new Map<string, Promise<unknown>>();
  /** Spends whose card call is running in this process; reconcile leaves them alone. */
  private readonly inflight = new Set<string>();
  private reconcileRun: Promise<void> | undefined;
  private fundingRun: Promise<void> | undefined;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: AppDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
  }

  // ---------- developer events ----------

  /** Fire and forget: a webhook problem must never hold up or fail a money movement. */
  private emit(userId: string, type: string, data: Record<string, unknown>): void {
    if (!this.d.onEvent) return;
    void this.d.onEvent(userId, type, data).catch((e) => this.log(`event ${type} for ${userId}: ${errText(e)}`));
  }

  private emitForCard(cardId: string, type: string, data: Record<string, unknown>): void {
    if (!this.d.onEvent) return;
    void this.d.pool.query("SELECT user_id FROM app_card WHERE card_id = $1", [cardId])
      .then((r) => r.rows[0] && this.emit(r.rows[0].user_id, type, { cardId, ...data }))
      .catch((e) => this.log(`event ${type} for card ${cardId}: ${errText(e)}`));
  }

  /** Reports a spend that has just reached a final status. */
  private emitSpend(spendId: string): void {
    if (!this.d.onEvent) return;
    void this.d.pool.query("SELECT s.*, c.user_id FROM app_spend s JOIN app_card c ON c.card_id = s.card_id WHERE s.spend_id = $1", [spendId])
      .then((r) => {
        const s = r.rows[0];
        if (!s || s.status === "processing") return;
        this.emit(s.user_id, "spend.settled", {
          spendId, cardId: s.card_id, agentId: s.agent_id, status: s.status, amountCents: num(s.amount_cents), merchant: s.merchant, mcc: s.mcc, reason: s.reason,
        });
      })
      .catch((e) => this.log(`event spend.settled for ${spendId}: ${errText(e)}`));
  }

  // ---------- boot ----------

  /** Rebuilds in-memory agent state from Postgres and settles anything a crash left half done. */
  async restore(): Promise<void> {
    const agents = await this.d.pool.query("SELECT * FROM app_agent");
    for (const a of agents.rows) this.d.wallets.create(a.card_id, a.agent_id, policyOf(a));
    const since = new Date(this.now().getTime() - 2 * 86_400_000);
    // Processing spends count too: their money is held until reconcileSpends() learns what the card did.
    const spends = await this.d.pool.query(
      "SELECT spend_id, card_id, agent_id, amount_cents, created_at FROM app_spend WHERE status IN ('approved', 'processing') AND created_at >= $1",
      [since],
    );
    for (const s of spends.rows) this.d.wallets.restoreSpend(s.card_id, s.agent_id, s.spend_id, num(s.amount_cents), s.created_at);
  }

  // ---------- users ----------

  async signup(emailIn: unknown): Promise<{ userId: string; token: string }> {
    const email = requireText(emailIn, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, "email is not valid");
    const userId = newId("u");
    const token = newToken("uk");
    try {
      await this.d.pool.query("INSERT INTO app_user (id, email, token_hash) VALUES ($1, $2, $3)", [userId, email, hashToken(token)]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AppError(409, "that email already has an account");
      throw e;
    }
    return { userId, token };
  }

  /**
   * A user made through the developer API. They have no owner token (nobody can sign in to the dashboard as them);
   * the developer reaches them with the developer key, and the end user with a short-lived session.
   * The same externalId returns the same user.
   */
  async createManagedUser(developerId: string, externalIdIn: unknown, emailIn: unknown, privacyIn?: unknown): Promise<{ userId: string; created: boolean }> {
    const externalId = requireText(externalIdIn, "externalId", 120);
    const email = requireText(emailIn, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, "email is not valid");
    if (privacyIn !== undefined && privacyIn !== null && typeof privacyIn !== "boolean") throw new AppError(400, "privacyMode must be true or false");
    const existing = await this.d.pool.query("SELECT id FROM app_user WHERE developer_id = $1 AND external_id = $2", [developerId, externalId]);
    if (existing.rows[0]) return { userId: existing.rows[0].id, created: false };
    // Privacy mode is fixed at creation: the developer's default unless this user is created with an explicit choice.
    const privacy = typeof privacyIn === "boolean"
      ? privacyIn
      : (await this.d.pool.query("SELECT privacy_mode FROM app_developer WHERE id = $1", [developerId])).rows[0]?.privacy_mode === true;
    const userId = newId("u");
    try {
      // A token nobody is given: the owner API needs a uk_ token, and this one is never shown.
      await this.d.pool.query(
        "INSERT INTO app_user (id, email, token_hash, developer_id, external_id, privacy_mode) VALUES ($1, $2, $3, $4, $5, $6)",
        [userId, email, hashToken(newToken("uk")), developerId, externalId, privacy],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        const again = await this.d.pool.query("SELECT id FROM app_user WHERE developer_id = $1 AND external_id = $2", [developerId, externalId]);
        if (again.rows[0]) return { userId: again.rows[0].id, created: false };
        throw new AppError(409, "that email already has an account");
      }
      throw e;
    }
    return { userId, created: true };
  }

  /** Whether this user's payments each use a fresh one-time card. */
  async privacyMode(userId: string): Promise<boolean> {
    const r = await this.d.pool.query("SELECT privacy_mode FROM app_user WHERE id = $1", [userId]);
    return r.rows[0]?.privacy_mode === true;
  }

  /** The user's id and the developer who owns them, if any. */
  async userOwner(userId: string): Promise<{ developerId: string | null; externalId: string | null } | undefined> {
    const r = await this.d.pool.query("SELECT developer_id, external_id FROM app_user WHERE id = $1", [userId]);
    return r.rows[0] ? { developerId: r.rows[0].developer_id, externalId: r.rows[0].external_id } : undefined;
  }

  /** Mints a session for one of the developer's users. The raw token is returned once. */
  async createSession(developerId: string, userId: string, ttlSeconds: number): Promise<{ token: string; expiresAt: string }> {
    const owner = await this.userOwner(userId);
    if (!owner || owner.developerId !== developerId) throw new AppError(404, "user not found");
    const token = newToken("us");
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    await this.d.pool.query("INSERT INTO app_session (token_hash, user_id, developer_id, expires_at) VALUES ($1, $2, $3, $4)", [hashToken(token), userId, developerId, expiresAt]);
    // Sessions are cheap; keep the table small.
    await this.d.pool.query("DELETE FROM app_session WHERE expires_at < $1", [new Date(this.now().getTime() - 86_400_000)]);
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async userBySession(token: string): Promise<string | undefined> {
    const r = await this.d.pool.query("SELECT user_id FROM app_session WHERE token_hash = $1 AND expires_at > $2", [hashToken(token), this.now()]);
    return r.rows[0]?.user_id;
  }

  /** Replaces the user's token; the old one stops working at once. */
  async rotateToken(userId: string): Promise<{ token: string }> {
    const token = newToken("uk");
    await this.d.pool.query("UPDATE app_user SET token_hash = $2 WHERE id = $1", [userId, hashToken(token)]);
    return { token };
  }

  async userByToken(token: string): Promise<string | undefined> {
    const r = await this.d.pool.query("SELECT id FROM app_user WHERE token_hash = $1", [hashToken(token)]);
    return r.rows[0]?.id;
  }

  /** Sends the user's identity straight to Miden. Nothing but the reference and status is kept. */
  async submitKyc(userId: string, input: Partial<IndividualKyc>): Promise<{ kycStatus: string }> {
    const user = await this.user(userId);
    if (user.kyc_status === "Approved") throw new AppError(409, "KYC is already approved");
    if (user.kyc_status === "Initiated" || user.kyc_status === "Pending") throw new AppError(409, "KYC is already in review");
    const kyc = validateKyc(input);
    // A fresh reference per attempt, so a resubmission after rejection is a new Miden request.
    const reference = `kyc-${userId}-${randomBytes(3).toString("hex")}`;
    const res = await this.d.miden.request<{ isSuccessful?: boolean; responseCode?: string; responseMessage?: string; kycStatus?: string }>(
      "POST",
      "/api/v1/cards/kyc-submit",
      {
        customerType: "Individual",
        phone: kyc.phone,
        email: kyc.email,
        clientReference: reference,
        individualKyc: {
          firstName: kyc.firstName, lastName: kyc.lastName, dateOfBirth: kyc.dateOfBirth, idType: kyc.idType,
          idNumber: kyc.idNumber, idFrontImage: kyc.idFrontImage, address: kyc.address,
        },
      },
      { reference: referenceFor(`kyc:${reference}`) },
    ).catch((e) => {
      if (e instanceof MidenApiError) throw new AppError(422, `Miden rejected the KYC submission: ${midenMessage(e)}`);
      throw e;
    });
    if (res.isSuccessful !== true || (res.responseCode !== "000" && res.responseCode !== "00")) {
      throw new AppError(422, `Miden rejected the KYC submission: ${res.responseMessage ?? res.responseCode ?? "unknown error"}`);
    }
    const status = res.kycStatus ?? "Initiated";
    await this.d.pool.query("UPDATE app_user SET kyc_reference = $2, kyc_status = $3 WHERE id = $1", [userId, reference, status]);
    // The submission is recorded; a failed status read is retried by the background poller.
    await this.refresh(userId).catch((e) => this.log(`kyc ${userId}: refresh after submit failed: ${errText(e)}`));
    return { kycStatus: (await this.user(userId)).kyc_status };
  }

  /** Reads KYC status from Miden and, once approved, issues the user's card and deposit address. Safe to repeat. */
  async refresh(userId: string): Promise<void> {
    const running = this.issuing.get(userId);
    if (running) return running;
    const p = this.doRefresh(userId).finally(() => this.issuing.delete(userId));
    this.issuing.set(userId, p);
    return p;
  }

  private async doRefresh(userId: string): Promise<void> {
    const user = await this.user(userId);
    const existing = await this.cardOf(userId);
    if (existing) {
      await this.ensureDepositAddress(existing.card_id);
      return;
    }
    if (!user.kyc_reference) return;
    const kyc = await this.d.lifecycle.kycStatus(user.kyc_reference);
    if (kyc.status !== user.kyc_status) {
      await this.d.pool.query("UPDATE app_user SET kyc_status = $2 WHERE id = $1", [userId, kyc.status]);
      this.emit(userId, "kyc.updated", { kycStatus: kyc.status });
    }
    if (kyc.status !== "Approved" || !kyc.customerId || !kyc.kycToken) return;
    const limits = this.d.tiers[user.tier as Tier];
    const policy: SpendPolicy = { perTransactionCents: limits.perTransactionCents, dailyCents: limits.dailyCents };
    // clientReference is stable per user, so the Reference header makes a retried issuance idempotent for 24h.
    const card = await this.d.cards.issue(`user-${userId}`, policy, { customerId: kyc.customerId, kycToken: kyc.kycToken }, `card-${userId}`);
    await this.d.pool.query(
      "INSERT INTO app_card (card_id, user_id, customer_id, per_txn_cents, daily_cents) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id) DO NOTHING",
      [card.id, userId, kyc.customerId, policy.perTransactionCents, policy.dailyCents],
    );
    this.log(`card issued for ${userId}`);
    this.emit(userId, "card.issued", { cardId: card.id });
    await this.ensureDepositAddress(card.id);
  }

  /** One address per card even when two callers race in this process; they share the running call. */
  private readonly addressing = new Map<string, Promise<string>>();

  private ensureDepositAddress(cardId: string): Promise<string> {
    const running = this.addressing.get(cardId);
    if (running) return running;
    const p = this.doEnsureDepositAddress(cardId).finally(() => this.addressing.delete(cardId));
    this.addressing.set(cardId, p);
    return p;
  }

  private async doEnsureDepositAddress(cardId: string): Promise<string> {
    const have = await this.d.pool.query("SELECT address FROM deposit_address WHERE card_id = $1 AND derivation_index IS NOT NULL ORDER BY derivation_index LIMIT 1", [cardId]);
    if (have.rows[0]) return have.rows[0].address;
    const idx = num((await this.d.pool.query("SELECT nextval('deposit_derivation_seq') AS i")).rows[0].i);
    const address = (await this.d.deriveAddress(idx)).toLowerCase();
    await this.d.addresses.add(address, cardId);
    await this.d.pool.query("UPDATE deposit_address SET derivation_index = $2 WHERE address = $1", [address, idx]);
    return address;
  }

  /** Everything the owner's dashboard shows. */
  async overview(userId: string) {
    const user = await this.user(userId);
    const card = await this.cardOf(userId);
    const base = { userId, email: user.email as string, tier: user.tier as Tier, kycStatus: user.kyc_status as string, privacyMode: user.privacy_mode === true, sandbox: this.d.sandbox, simulatedDeposits: !!(this.d.sandbox && this.d.simulatedDeposits) };
    if (!card) return { ...base, card: null };
    const cardId = card.card_id as string;
    const [holding, pending, onCard, address, agents, fundings, deposits] = await Promise.all([
      this.d.ledger.balance(accounts.holding(cardId)),
      this.d.ledger.balance(accounts.pending(cardId)),
      this.d.ledger.balance(accounts.card(cardId)),
      this.d.pool.query("SELECT address FROM deposit_address WHERE card_id = $1 AND derivation_index IS NOT NULL ORDER BY derivation_index LIMIT 1", [cardId]),
      this.agentsOf(cardId),
      this.d.pool.query("SELECT funding_id, amount_cents, status, detail, created_at FROM app_funding WHERE card_id = $1 ORDER BY created_at DESC LIMIT 20", [cardId]),
      this.d.ledger.history(accounts.holding(cardId)),
    ]);
    const midenBalance = await this.d.lifecycle.cardBalance(cardId).catch(() => null);
    const funded = num((await this.d.pool.query("SELECT COALESCE(sum(amount_cents), 0) AS s FROM app_funding WHERE card_id = $1 AND status IN ('reserved', 'completed')", [cardId])).rows[0].s);
    const cap = this.d.tiers[user.tier as Tier].lifetimeFundedCents;
    return {
      ...base,
      card: {
        cardId,
        limits: { perTransactionCents: num(card.per_txn_cents), dailyCents: num(card.daily_cents) },
        lifetimeFundingCapCents: this.d.tiers[user.tier as Tier].lifetimeFundedCents,
        balances: {
          awaitingFundingCents: holding,
          awaitingFundingReason: holdingReason(holding, cap - funded, cap),
          fundingInFlightCents: pending,
          unallocatedOnCardCents: onCard,
        },
        lifetimeFundedCents: funded,
        midenCardBalanceDollars: midenBalance,
        deposit: { chain: this.d.chain, asset: "USDC", address: address.rows[0]?.address ?? null, networks: this.d.depositNetworks ?? [this.d.chain, "ethereum-sepolia"], rail: this.d.depositRail ?? "chain" },
        deposits: deposits.filter((t) => t.kind === "deposit").reverse().slice(0, 20).map((t) => ({
          reference: t.reference,
          amountCents: t.postings.find((p) => p.account === accounts.holding(cardId))?.amountCents ?? 0,
          simulated: t.idempotencyKey.startsWith("deposit:sandbox-sim:"),
          chain: t.idempotencyKey.split(":")[1],
          at: t.createdAt,
        })),
        fundings: fundings.rows.map((f) => ({ fundingId: f.funding_id, amountCents: num(f.amount_cents), status: f.status, detail: f.detail, at: f.created_at })),
        agents,
      },
    };
  }

  /** Sandbox only: credits a deposit as if the chain watcher had seen one. Labelled as simulated in the ledger. */
  async simulateDeposit(userId: string, amountCentsIn: unknown): Promise<void> {
    if (!this.d.sandbox || !this.d.simulatedDeposits) throw new AppError(403, "simulated deposits are switched off (sandbox only, ALLOW_SIMULATED_DEPOSITS=1)");
    const amountCents = requireCents(amountCentsIn, "amountCents");
    if (amountCents > 100_000) throw new AppError(400, "simulated deposits are capped at $1,000");
    const card = await this.requireCard(userId);
    await this.d.ledger.confirmDeposit({ chain: "sandbox-sim", asset: "USDC", cardId: card.card_id, amountCents, txHash: newId("sim", 16), logIndex: 0 });
    void this.fundPending().catch((e) => this.log(`funding: ${errText(e)}`));
  }

  /**
   * Sandbox only: credits a deposit by address, from an id like `sim_<address>_USDC_<amount>` (see parseSimDeposit),
   * through the same ledger.confirmDeposit the chain watcher uses. The address must be this user's own deposit
   * address, so one user cannot credit another's card. The id is the idempotency key.
   */
  async simulateChainDeposit(userId: string, id: unknown): Promise<{ amountCents: number }> {
    if (!this.d.sandbox || !this.d.simulatedDeposits) throw new AppError(403, "simulated deposits are switched off (sandbox only, ALLOW_SIMULATED_DEPOSITS=1)");
    const hint = typeof id === "string" ? parseSimDeposit(id) : null;
    if (!hint) throw new AppError(400, `id must look like ${SIM_DEPOSIT_PREFIX}<0x address>_<USDC|USDT>_<amount in dollars>[_<nonce>]`);
    if (hint.amountCents > 100_000) throw new AppError(400, "simulated deposits are capped at $1,000");
    const card = await this.requireCard(userId);
    if ((await this.d.addresses.cardFor(hint.address)) !== card.card_id) throw new AppError(404, "that is not one of your deposit addresses");
    await this.d.ledger.confirmDeposit({ chain: "sandbox-sim", asset: hint.asset, cardId: card.card_id, amountCents: hint.amountCents, txHash: hint.id, logIndex: 0 });
    void this.fundPending().catch((e) => this.log(`funding: ${errText(e)}`));
    return { amountCents: hint.amountCents };
  }

  // ---------- funding: holding -> Miden card ----------

  /**
   * Moves credited deposits onto each card with a Miden top-up. A row is written before the ledger
   * reserve and the Miden call share its id, so a crash anywhere is finished by the next run: the
   * Reference header makes the retried top-up land at most once.
   */
  fundPending(): Promise<void> {
    // One run at a time; a caller arriving mid-run waits for that run.
    this.fundingRun ??= this.doFundPending().finally(() => (this.fundingRun = undefined));
    return this.fundingRun;
  }

  private async doFundPending(): Promise<void> {
    {
      const open = await this.d.pool.query("SELECT funding_id, card_id, amount_cents, created_at FROM app_funding WHERE status = 'reserved' ORDER BY created_at");
      for (const f of open.rows) {
        const stale = this.now().getTime() - new Date(f.created_at).getTime() > RESEND_WINDOW_MS;
        // Past the Reference window a re-send could top up twice, so only look for the first one.
        if (stale) await this.findLostFunding(f.funding_id, f.card_id, num(f.amount_cents));
        else await this.settleFunding(f.funding_id, f.card_id, num(f.amount_cents));
      }
      const cards = await this.d.pool.query("SELECT c.card_id, u.tier FROM app_card c JOIN app_user u ON u.id = c.user_id");
      for (const c of cards.rows) {
        const holding = await this.d.ledger.balance(accounts.holding(c.card_id));
        if (holding < MIN_FUNDING_CENTS) continue;
        const done = await this.d.pool.query("SELECT COALESCE(sum(amount_cents), 0) AS s FROM app_funding WHERE card_id = $1 AND status IN ('reserved', 'completed')", [c.card_id]);
        const room = this.d.tiers[c.tier as Tier].lifetimeFundedCents - num(done.rows[0].s);
        const amount = Math.min(holding, room);
        if (amount < MIN_FUNDING_CENTS) continue; // over the tier's lifetime cap: stays in holding until the user upgrades
        const fundingId = newId("fund", 8);
        await this.d.pool.query("INSERT INTO app_funding (funding_id, card_id, amount_cents, status) VALUES ($1, $2, $3, 'reserved')", [fundingId, c.card_id, amount]);
        await this.settleFunding(fundingId, c.card_id, amount);
      }
    }
  }

  private async settleFunding(fundingId: string, cardId: string, amountCents: number): Promise<void> {
    const set = (status: string, detail: string | null) =>
      this.d.pool.query("UPDATE app_funding SET status = $2, detail = $3, updated_at = now() WHERE funding_id = $1", [fundingId, status, detail]);
    try {
      await this.d.ledger.reserveFunding({ cardId, amountCents, fundingId });
    } catch (e) {
      // Never reserved (holding moved on): nothing was sent, so the row is simply closed.
      await set("released", `not reserved: ${errText(e)}`);
      return;
    }
    let landed: boolean;
    let detail: string | null = null;
    try {
      if (await this.isPrivacyCard(cardId)) {
        // Privacy mode: the money stays in the Miden wallet and pays for each one-time card as it is issued.
        landed = true;
        detail = "privacy mode: held in the Miden wallet";
      } else {
        const receipt = await this.d.funding.fund({ cardId, amountCents, asset: "USDC", idempotencyKey: fundingId });
        landed = receipt.status === "confirmed";
        detail = `miden ${receipt.id}`;
      }
    } catch (e) {
      if (e instanceof MidenDuplicateReferenceError) {
        // Miden has seen this Reference, which does not prove the top-up succeeded: look for it.
        await this.findLostFunding(fundingId, cardId, amountCents);
        return;
      } else if (e instanceof MidenApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        landed = false;
        detail = midenMessage(e);
      } else {
        this.log(`funding ${fundingId} will retry: ${errText(e)}`);
        return; // indeterminate: stays reserved, retried with the same Reference
      }
    }
    if (landed) {
      await this.d.ledger.completeFunding({ cardId, amountCents, fundingId });
      await set("completed", detail);
      this.emitForCard(cardId, "funding.completed", { fundingId, amountCents });
      this.log(`funded card ${cardId.slice(0, 8)} with ${amountCents}c`);
    } else {
      await this.d.ledger.releaseFunding({ cardId, amountCents, fundingId });
      await set("released", detail);
    }
  }

  /**
   * Settles a reserved top-up from the card's own record: CardFunding carries our clientReference
   * (= fundingId) as transactionReference. Not found means unknown, so it stays reserved for a person to check.
   */
  private async findLostFunding(fundingId: string, cardId: string, amountCents: number): Promise<void> {
    let txs: CardTransaction[];
    try {
      txs = await this.d.lifecycle.transactions(cardId, "CardFunding", 100);
    } catch (e) {
      this.log(`funding ${fundingId}: lookup failed, will retry: ${errText(e)}`);
      return;
    }
    const t = txs.find((x) => x.transactionReference === fundingId);
    if (t && /^(approved|successful)$/i.test(t.transactionStatus ?? "")) {
      await this.d.ledger.completeFunding({ cardId, amountCents, fundingId });
      await this.d.pool.query("UPDATE app_funding SET status = 'completed', detail = $2, updated_at = now() WHERE funding_id = $1", [fundingId, `found on the card (${t.id ?? "?"})`]);
      this.emitForCard(cardId, "funding.completed", { fundingId, amountCents });
      this.log(`funding ${fundingId}: found on the card, completed`);
    } else if (t && /^(declined|failed)$/i.test(t.transactionStatus ?? "")) {
      await this.d.ledger.releaseFunding({ cardId, amountCents, fundingId });
      await this.d.pool.query("UPDATE app_funding SET status = 'released', detail = $2, updated_at = now() WHERE funding_id = $1", [fundingId, `card shows ${t.transactionStatus}`]);
    } else {
      this.log(`funding ${fundingId}: not on the card's recent CardFunding list${t ? ` (status ${t.transactionStatus})` : ""}; left reserved for review`);
    }
  }

  // ---------- agents (owner side) ----------

  async createAgent(userId: string, body: { name?: unknown; perTransactionCents?: unknown; dailyCents?: unknown; allowedMccs?: unknown }) {
    const card = await this.requireCard(userId);
    const name = requireText(body.name, "name", 80);
    const requested: SpendPolicy = {
      perTransactionCents: requireCents(body.perTransactionCents, "perTransactionCents"),
      dailyCents: requireCents(body.dailyCents, "dailyCents"),
    };
    const mccs = parseMccs(body.allowedMccs);
    if (mccs) requested.allowedMccs = mccs;
    checkAgentLimits(requested, card);
    // An agent never gets more room than its owner's card.
    const policy = capPolicy({ perTransactionCents: num(card.per_txn_cents), dailyCents: num(card.daily_cents), lifetimeFundedCents: 0 }, requested);
    const agentId = newId("a", 4);
    const token = newToken("ak");
    await this.d.pool.query(
      "INSERT INTO app_agent (card_id, agent_id, name, token_hash, per_txn_cents, daily_cents, allowed_mccs) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [card.card_id, agentId, name, hashToken(token), policy.perTransactionCents, policy.dailyCents, policy.allowedMccs ?? null],
    );
    this.d.wallets.create(card.card_id, agentId, policy);
    return { agentId, name, policy, token };
  }

  async fundAgent(userId: string, agentId: string, amountCentsIn: unknown, key?: unknown): Promise<void> {
    const card = await this.requireCard(userId);
    const agent = await this.requireAgent(card.card_id, agentId);
    if (agent.revoked_at) throw new AppError(409, "agent is revoked");
    const amountCents = requireCents(amountCentsIn, "amountCents");
    const allocationId = typeof key === "string" && key ? `${card.card_id}:${agentId}:${key}` : newId("alloc", 8);
    await this.d.wallets.fund(card.card_id, agentId, amountCents, allocationId).catch((e) => {
      if (/insufficient/.test(errText(e))) throw new AppError(409, "not enough unallocated money on the card");
      throw e;
    });
  }

  async reclaimAgent(userId: string, agentId: string, amountCentsIn?: unknown): Promise<number> {
    const card = await this.requireCard(userId);
    await this.requireAgent(card.card_id, agentId);
    // A payment can debit the agent between our balance read and the reclaim: re-read and try once more.
    for (let attempt = 0; ; attempt++) {
      const balance = await this.d.wallets.balance(card.card_id, agentId);
      const amountCents = amountCentsIn === undefined ? balance : requireCents(amountCentsIn, "amountCents");
      if (amountCents === 0) return 0;
      if (amountCents > balance) throw new AppError(409, "agent does not hold that much");
      try {
        await this.d.wallets.reclaim(card.card_id, agentId, amountCents, newId("ret", 8));
        return amountCents;
      } catch (e) {
        if (!(e instanceof LedgerError) && !/insufficient/.test(errText(e))) throw e;
        if (attempt > 0) throw new AppError(409, "the agent's balance changed while reclaiming; try again");
      }
    }
  }

  /** Revokes the agent's token for good and returns its money to the card. */
  async revokeAgent(userId: string, agentId: string): Promise<void> {
    const card = await this.requireCard(userId);
    await this.d.pool.query("UPDATE app_agent SET revoked_at = COALESCE(revoked_at, now()) WHERE card_id = $1 AND agent_id = $2", [card.card_id, agentId]);
    await this.reclaimAgent(userId, agentId);
  }

  async updateAgentLimits(userId: string, agentId: string, body: { perTransactionCents?: unknown; dailyCents?: unknown; allowedMccs?: unknown }) {
    const card = await this.requireCard(userId);
    const agent = await this.requireAgent(card.card_id, agentId);
    const requested: SpendPolicy = {
      perTransactionCents: body.perTransactionCents === undefined ? num(agent.per_txn_cents) : requireCents(body.perTransactionCents, "perTransactionCents"),
      dailyCents: body.dailyCents === undefined ? num(agent.daily_cents) : requireCents(body.dailyCents, "dailyCents"),
    };
    const mccs = body.allowedMccs === undefined ? (agent.allowed_mccs ?? undefined) : parseMccs(body.allowedMccs);
    if (mccs) requested.allowedMccs = mccs;
    checkAgentLimits(requested, card);
    const policy = capPolicy({ perTransactionCents: num(card.per_txn_cents), dailyCents: num(card.daily_cents), lifetimeFundedCents: 0 }, requested);
    await this.d.pool.query(
      "UPDATE app_agent SET per_txn_cents = $3, daily_cents = $4, allowed_mccs = $5 WHERE card_id = $1 AND agent_id = $2",
      [card.card_id, agentId, policy.perTransactionCents, policy.dailyCents, policy.allowedMccs ?? null],
    );
    this.d.wallets.setPolicy(card.card_id, agentId, policy);
    return policy;
  }

  private async agentsOf(cardId: string) {
    const rows = (await this.d.pool.query("SELECT * FROM app_agent WHERE card_id = $1 ORDER BY created_at", [cardId])).rows;
    return Promise.all(rows.map(async (a) => ({
      agentId: a.agent_id as string,
      name: a.name as string,
      revoked: a.revoked_at !== null,
      policy: policyOf(a),
      balanceCents: await this.d.wallets.balance(cardId, a.agent_id),
      spentTodayCents: await this.spentToday(cardId, a.agent_id),
      recent: await this.spends(cardId, a.agent_id, 10),
    })));
  }

  // ---------- privacy mode: one-time cards ----------

  private async isPrivacyCard(cardId: string): Promise<boolean> {
    const r = await this.d.pool.query("SELECT u.privacy_mode FROM app_card c JOIN app_user u ON u.id = c.user_id WHERE c.card_id = $1", [cardId]);
    return r.rows[0]?.privacy_mode === true;
  }

  /**
   * The card a payment is charged to: the user's own card, or, in privacy mode, a one-time card issued for exactly this
   * payment (after the agent's limits passed and its money was debited). One row per spend, written before the issue
   * call, so the same spend never gets two cards and a crash mid-issue is flagged, not guessed at.
   * Throws an AppError when no card could be made; the caller then undoes the debit (nothing was charged).
   * `needDetails`: also seal the card's details into the vault (a hosted-checkout fill needs them; the simulator does not).
   */
  async chargeCardFor(p: AgentPrincipal, spendId: string, amountCents: number, opts: { needDetails: boolean }): Promise<string> {
    if (!(await this.privacyMode(p.userId))) return p.cardId;
    const pool = this.d.pool;
    const prior = (await pool.query("SELECT * FROM app_one_time_card WHERE spend_id = $1", [spendId])).rows[0];
    if (prior?.status === "ready" && prior.card_id) return prior.card_id;
    // Miden loads at least $1 on a Lite card, so a smaller payment would park the rest of a dollar on a single-swipe card.
    if (!prior && amountCents < ONE_TIME_MIN_CENTS) throw new AppError(422, "privacy mode needs a payment of at least $1.00 (the smallest one-time card); nothing was charged");
    // A card that is refused or abandoned keeps its funds until it terminates, so cap how fast one user can make cards.
    if (!prior) {
      const n = Number((await pool.query("SELECT count(*) AS n FROM app_one_time_card WHERE user_id = $1 AND created_at > now() - interval '24 hours'", [p.userId])).rows[0].n);
      if (n >= ONE_TIME_MAX_PER_DAY) throw new AppError(429, `privacy mode allows ${ONE_TIME_MAX_PER_DAY} one-time cards a day per user; nothing was charged`);
    }
    if (prior) throw new AppError(409, "a one-time card for this payment was already attempted and needs a person to look at it; nothing was charged");
    const rowId = newId("ot", 8);
    const mark = (status: string, detail: string | null, cardId?: string) =>
      pool.query("UPDATE app_one_time_card SET status = $2, detail = $3, card_id = COALESCE($4, card_id), updated_at = now() WHERE one_time_id = $1", [rowId, status, detail, cardId ?? null]);
    try {
      await pool.query("INSERT INTO app_one_time_card (one_time_id, user_id, spend_id, amount_cents, status) VALUES ($1, $2, $3, $4, 'issuing')", [rowId, p.userId, spendId, amountCents]);
    } catch (e) {
      // A concurrent attempt for the same spend won the unique index.
      if ((e as { code?: string }).code === "23505") throw new AppError(409, "a one-time card for this payment is already being made; nothing was charged");
      throw e;
    }
    const user = await this.user(p.userId);
    let kyc: { status: string; customerId?: string; kycToken?: string };
    try {
      kyc = await this.d.lifecycle.kycStatus(user.kyc_reference);
    } catch (e) {
      await mark("failed", `KYC lookup failed: ${errText(e)}`.slice(0, 200));
      throw new AppError(503, "could not look up the cardholder to make a one-time card; nothing was charged");
    }
    if (kyc.status !== "Approved" || !kyc.customerId || !kyc.kycToken) {
      await mark("failed", `KYC status ${kyc.status}`);
      throw new AppError(409, "the cardholder is not approved, so no one-time card can be made; nothing was charged");
    }
    let out: { cardId: string; detailsCaptured: boolean };
    try {
      out = await this.d.cards.issueOneTime({ customerId: kyc.customerId, kycToken: kyc.kycToken }, amountCents, `ot-${spendId}`, { capture: opts.needDetails });
    } catch (e) {
      if (isDefiniteRefusal(e)) {
        const why = e instanceof MidenApiError ? midenMessage(e) : errText(e);
        await mark("failed", why.slice(0, 200));
        throw new AppError(422, `could not make a one-time card (${why}); nothing was charged`);
      }
      // A timeout or lost answer: the card may exist (and hold the money). Never guess; a person decides.
      await mark("needs_review", `issue answer lost: ${errText(e)}`.slice(0, 200));
      this.log(`one-time card for spend ${spendId}: issue answer lost, flagged for review`);
      throw new AppError(503, "the one-time card could not be confirmed; nothing was charged and the attempt is flagged for review");
    }
    if (opts.needDetails && !out.detailsCaptured) {
      await mark("needs_review", "card issued but its details could not be captured", out.cardId);
      throw new AppError(502, "the one-time card was made but its details were unavailable; nothing was charged and the card is flagged for review");
    }
    await mark("ready", null, out.cardId);
    await pool.query("UPDATE app_spend SET charge_card_id = $2 WHERE spend_id = $1", [spendId, out.cardId]);
    this.log(`one-time card ${out.cardId.slice(0, 8)} made for spend ${spendId}`);
    return out.cardId;
  }

  // ---------- agents (agent side) ----------

  async agentByToken(token: string): Promise<AgentPrincipal | undefined> {
    const r = await this.d.pool.query(
      "SELECT a.card_id, a.agent_id, a.name, c.user_id FROM app_agent a JOIN app_card c ON c.card_id = a.card_id WHERE a.token_hash = $1 AND a.revoked_at IS NULL",
      [hashToken(token)],
    );
    const a = r.rows[0];
    return a ? { cardId: a.card_id, agentId: a.agent_id, name: a.name, userId: a.user_id } : undefined;
  }

  async agentWallet(p: AgentPrincipal) {
    const policy = this.d.wallets.policy(p.cardId, p.agentId);
    if (!policy) throw new AppError(404, "agent not found");
    const spentTodayCents = await this.spentToday(p.cardId, p.agentId);
    return {
      agentId: p.agentId,
      name: p.name,
      currency: "USD",
      balanceCents: await this.d.wallets.balance(p.cardId, p.agentId),
      limits: { perTransactionCents: policy.perTransactionCents, dailyCents: policy.dailyCents, allowedMccs: policy.allowedMccs ?? null },
      spentTodayCents,
      remainingTodayCents: Math.max(0, policy.dailyCents - spentTodayCents),
    };
  }

  async agentTransactions(p: AgentPrincipal, limit = 20): Promise<SpendView[]> {
    return this.spends(p.cardId, p.agentId, Math.min(Math.max(1, limit), 100));
  }

  /**
   * An agent pays a merchant with its owner's card. Our policy and the agent's sub-balance are checked
   * and debited first; then the card is charged (sandbox: Miden's simulated authorization). If the card
   * definitely refuses, our debit is reversed. If its answer is lost (timeout, 5xx), the payment stays
   * "processing" with the money held, and reconcileSpends() settles it from the card's transactions.
   * The same idempotency key never charges twice.
   */
  async pay(p: AgentPrincipal, req: PayRequest, opts: { internal?: boolean; charge?: Charger } = {}): Promise<SpendView> {
    const amountCents = requireCents(req.amountCents, "amount");
    const merchant = requireText(req.merchant, "merchant", 80);
    const mcc = req.mcc === undefined || req.mcc === null || req.mcc === "" ? undefined : String(req.mcc);
    if (mcc !== undefined && !/^\d{4}$/.test(mcc)) throw new AppError(400, "mcc must be 4 digits");
    const key = req.idempotencyKey === undefined || req.idempotencyKey === "" ? newId("auto", 12) : requireText(req.idempotencyKey, "idempotencyKey", 100);
    // Checkout keys are ours (CheckoutService): an agent pre-spending under one could pass it off as the checkout's payment.
    if (key.startsWith(INTERNAL_KEY_PREFIX) && !opts.internal) throw new AppError(400, `idempotencyKey must not start with "${INTERNAL_KEY_PREFIX}"`);
    // A swap charge must live under a swap key, so the right reconcile owns it; and a swap key always has one.
    if (Boolean(opts.charge) !== key.startsWith(SWAP_KEY_PREFIX)) throw new AppError(400, "a custom charge needs a swap key, and a swap key needs a custom charge");
    const lockKey = `${p.cardId}:${p.agentId}:${key}`;
    // One attempt per key at a time in this process; the unique index covers the rest.
    while (this.paying.has(lockKey)) await this.paying.get(lockKey)!.catch(() => undefined);
    const run = this.doPay(p, { amountCents, merchant, mcc, key }, opts.charge);
    this.paying.set(lockKey, run);
    try {
      return await run;
    } finally {
      this.paying.delete(lockKey);
    }
  }

  /** The earlier result for this key, or a 409 if the key was used for a different payment. */
  private async priorSpend(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }): Promise<SpendView | undefined> {
    const prior = await this.d.pool.query("SELECT * FROM app_spend WHERE card_id = $1 AND agent_id = $2 AND idempotency_key = $3", [p.cardId, p.agentId, r.key]);
    const s = prior.rows[0];
    if (!s) return undefined;
    if (num(s.amount_cents) !== r.amountCents || s.merchant !== r.merchant || (s.mcc ?? undefined) !== r.mcc) {
      throw new AppError(409, "that idempotency key was already used for a different payment");
    }
    return spendView(s);
  }

  /**
   * Records the spend, checking the agent's and the card's daily limits under a row lock on the card, so
   * concurrent payments (in any process) cannot both fit. Over a limit, the row is written as declined.
   */
  private async openSpend(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }, spendId: string, policy: SpendPolicy): Promise<SpendView> {
    const c = await this.d.pool.connect();
    try {
      await c.query("BEGIN");
      const card = (await c.query("SELECT daily_cents FROM app_card WHERE card_id = $1 FOR UPDATE", [p.cardId])).rows[0];
      if (!card) throw new AppError(404, "card not found");
      const [start, end] = this.today();
      const cardToday = num((await c.query(
        "SELECT COALESCE(sum(amount_cents), 0) AS s FROM app_spend WHERE card_id = $1 AND status IN ('approved', 'processing') AND created_at >= $2 AND created_at < $3",
        [p.cardId, start, end],
      )).rows[0].s);
      const agentToday = await this.spentToday(p.cardId, p.agentId, c);
      // The agent's own policy first (per payment, merchant category, daily), so its reasons read as before.
      const verdict = evaluate(policy, { amountCents: r.amountCents, mcc: r.mcc, spentTodayCents: agentToday });
      const reason = !verdict.ok ? verdict.reason
        : cardToday + r.amountCents > num(card.daily_cents) ? "card daily limit exceeded (shared by all agents on this card)"
        : null;
      const row = await c.query(
        "INSERT INTO app_spend (spend_id, card_id, agent_id, idempotency_key, amount_cents, merchant, mcc, status, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
        [spendId, p.cardId, p.agentId, r.key, r.amountCents, r.merchant, r.mcc ?? null, reason ? "declined" : "processing", reason],
      );
      await c.query("COMMIT");
      return spendView(row.rows[0]);
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  private async doPay(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }, charge?: Charger): Promise<SpendView> {
    const prior = await this.priorSpend(p, r);
    if (prior) return prior;
    const policy = this.d.wallets.policy(p.cardId, p.agentId);
    if (!policy) throw new AppError(404, "agent not found");
    const spendId = newId("sp", 10);
    // In flight from before the row exists, so this process's reconcile never judges a payment still under way.
    this.inflight.add(spendId);
    try {
      return await this.chargeSpend(p, r, policy, spendId, charge);
    } finally {
      this.inflight.delete(spendId);
    }
  }

  private async chargeSpend(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }, policy: SpendPolicy, spendId: string, charge?: Charger): Promise<SpendView> {
    let opened: SpendView;
    try {
      opened = await this.openSpend(p, r, spendId, policy);
    } catch (e) {
      // Another process inserted the same key first: answer with its result.
      if ((e as { code?: string }).code === "23505") {
        const again = await this.priorSpend(p, r);
        if (again) return again;
        throw new AppError(409, "a payment with that idempotency key is already in progress");
      }
      throw e;
    }
    if (opened.status !== "processing") return opened;
    const finish = async (status: SpendView["status"], reason: string | null, extra: { seq?: number; auth?: string } = {}) => {
      const row = await this.d.pool.query(
        "UPDATE app_spend SET status = $2, reason = $3, ledger_seq = COALESCE($4, ledger_seq), miden_auth_id = COALESCE($5, miden_auth_id) WHERE spend_id = $1 RETURNING *",
        [spendId, status, reason, extra.seq ?? null, extra.auth ?? null],
      );
      this.emitSpend(spendId);
      return spendView(row.rows[0]);
    };
    // Daily limits were checked in openSpend (Postgres, shared by every process); this checks the rest and debits.
    const verdict = await this.d.wallets.spend(p.cardId, p.agentId, r.amountCents, spendId, r.mcc, { dailyCheckedByCaller: true });
    if (!verdict.ok) return finish("declined", verdict.reason);
    const still = await this.d.pool.query("UPDATE app_spend SET ledger_seq = $2 WHERE spend_id = $1 AND status = 'processing'", [spendId, verdict.tx.seq]);
    if (still.rowCount === 0) {
      // Another process's reconcile closed it while the debit was slow: undo the debit and never charge the card.
      await this.d.wallets.voidSpend(spendId, verdict.tx);
      return spendView((await this.d.pool.query("SELECT * FROM app_spend WHERE spend_id = $1", [spendId])).rows[0]);
    }
    if (charge) {
      let out: ChargeOutcome;
      try {
        out = await charge(spendId);
      } catch (e) {
        out = { kind: "unknown", reason: `charge failed: ${errText(e)}` };
      }
      if (out.kind === "approved") return finish("approved", null, { seq: verdict.tx.seq, auth: out.auth });
      if (out.kind === "refused") {
        await this.d.wallets.voidSpend(spendId, verdict.tx);
        return finish("voided", out.reason);
      }
      this.log(`spend ${spendId}: swap charge outcome unknown, held for reconcile`);
      return finish("processing", out.reason, { seq: verdict.tx.seq });
    }
    if (!this.d.sandbox) {
      await this.d.wallets.voidSpend(spendId, verdict.tx);
      return finish("voided", "live card charging is not enabled: agents pay through the sandbox simulator only");
    }
    let cardId: string;
    try {
      cardId = await this.chargeCardFor(p, spendId, r.amountCents, { needDetails: false });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      await this.d.wallets.voidSpend(spendId, verdict.tx);
      return finish("voided", e.message);
    }
    try {
      const authId = await this.d.lifecycle.simulateAuthorization(
        { cardId, amountDollars: r.amountCents / 100, mcc: r.mcc, merchantName: r.merchant, mid: midFor(spendId) },
        { reference: referenceFor(`auth:${spendId}`) },
      );
      return finish("approved", null, { seq: verdict.tx.seq, auth: authId ?? undefined });
    } catch (e) {
      if (isDefiniteRefusal(e)) {
        await this.d.wallets.voidSpend(spendId, verdict.tx);
        return finish("voided", `card declined: ${e instanceof MidenApiError ? midenMessage(e) : errText(e)}`);
      }
      // We cannot tell whether the card was charged. Keep the money held; never re-send (the mock is not idempotent).
      this.log(`spend ${spendId}: card answer lost, reconciling later: ${errText(e)}`);
      return finish("processing", "waiting for the card network's answer; the money is held. Check again with list_transactions, and do not retry with a new key", { seq: verdict.tx.seq });
    }
  }

  /**
   * Settles payments left "processing" (lost card answer, crash, restart) from the card's own
   * Authorization list, matched exactly by the per-spend merchant id. Run it in the background.
   */
  reconcileSpends(): Promise<void> {
    this.reconcileRun ??= this.doReconcileSpends().finally(() => (this.reconcileRun = undefined));
    return this.reconcileRun;
  }

  private async doReconcileSpends(): Promise<void> {
    const before = new Date(this.now().getTime() - RECONCILE_AFTER_MS);
    // Swap spends are settled by SwapService.reconcile (matched on the card by amount and time, not by mid).
    const rows = (await this.d.pool.query(
      "SELECT * FROM app_spend WHERE status = 'processing' AND created_at < $1 AND NOT starts_with(idempotency_key, $2) ORDER BY created_at LIMIT 200",
      [before, SWAP_KEY_PREFIX],
    )).rows;
    const lists = new Map<string, Promise<CardTransaction[]>>();
    for (const s of rows) {
      if (this.inflight.has(s.spend_id)) continue;
      await this.reconcileSpend(s, lists).catch((e) => this.log(`reconcile ${s.spend_id}: ${errText(e)}`));
    }
  }

  private async reconcileSpend(s: Record<string, any>, lists: Map<string, Promise<CardTransaction[]>>): Promise<void> {
    const spendId = s.spend_id as string;
    const settle = async (status: SpendView["status"], reason: string | null, auth?: string) => {
      const r = await this.d.pool.query(
        "UPDATE app_spend SET status = $2, reason = $3, miden_auth_id = COALESCE($4, miden_auth_id) WHERE spend_id = $1 AND status = 'processing'",
        [spendId, status, reason, auth ?? null],
      );
      if (r.rowCount === 1) this.emitSpend(spendId);
      return r;
    };
    // Found by key, not ledger_seq: the debit can commit before its seq is saved on the row.
    const tx: LedgerTransaction | undefined = await this.d.ledger.findByKey(`spend:${spendId}`);
    if (!tx) {
      // The card is charged only after the agent is debited, so nothing was charged. Guarded on ledger_seq: if a
      // slow payment in another process debits meanwhile, it sees the row closed and undoes its own debit.
      await this.d.pool.query(
        "UPDATE app_spend SET status = 'voided', reason = 'interrupted before payment; nothing was charged' WHERE spend_id = $1 AND status = 'processing' AND ledger_seq IS NULL",
        [spendId],
      );
      return;
    }
    if (s.ledger_seq === null) await this.d.pool.query("UPDATE app_spend SET ledger_seq = $2 WHERE spend_id = $1 AND status = 'processing'", [spendId, tx.seq]);
    let found: CardTransaction | undefined;
    if (this.d.sandbox) {
      const onCard = (s.charge_card_id ?? s.card_id) as string;
      if (!lists.has(onCard)) lists.set(onCard, this.d.lifecycle.transactions(onCard, "Authorization", 100));
      const mid = midFor(spendId);
      found = (await lists.get(onCard)!).find((t) => t.merchantMid === mid);
    }
    const status = found?.transactionStatus ?? "";
    if (/^(approved|successful|settled)$/i.test(status)) {
      await settle("approved", null, found!.authCode);
      this.log(`reconcile ${spendId}: approved on the card`);
    } else if (/^(declined|failed|reversed)$/i.test(status)) {
      await this.d.wallets.voidSpend(spendId, tx);
      await settle("voided", `card declined (${status})`);
    } else {
      // Not found, or a status we do not know. Absence on one page of a lagging list does not prove it was
      // not charged, so never refund here: keep the money held and flag it for a person (like findLostFunding).
      const note = found
        ? `needs review: the card shows status "${status}"; the money is held`
        : this.now().getTime() - new Date(s.created_at).getTime() > GIVE_UP_AFTER_MS
          ? "needs review: the card network has no record of this payment yet; the money is held"
          : null;
      if (note && s.reason !== note) {
        await this.d.pool.query("UPDATE app_spend SET reason = $2 WHERE spend_id = $1 AND status = 'processing'", [spendId, note]);
        this.log(`reconcile ${spendId}: ${note}`);
      }
    }
  }

  /**
   * Settles a processing swap spend from outside (SwapService.reconcile): approved keeps the debit, voided
   * undoes it. Only ever moves a row out of processing, once; returns false if it was not processing.
   */
  async resolveSwapSpend(spendId: string, out: { status: "approved"; auth?: string } | { status: "voided"; reason: string }): Promise<boolean> {
    const s = (await this.d.pool.query("SELECT * FROM app_spend WHERE spend_id = $1", [spendId])).rows[0];
    if (!s || !String(s.idempotency_key).startsWith(SWAP_KEY_PREFIX)) return false;
    // A voided row is re-voided (the reversal is idempotent), which repairs a crash between closing the row and undoing the debit.
    if (s.status !== "processing" && !(s.status === "voided" && out.status === "voided")) return false;
    if (out.status === "approved") {
      const r = await this.d.pool.query(
        "UPDATE app_spend SET status = 'approved', reason = NULL, miden_auth_id = COALESCE($2, miden_auth_id) WHERE spend_id = $1 AND status = 'processing'",
        [spendId, out.auth ?? null],
      );
      if (r.rowCount === 1) this.emitSpend(spendId);
      return r.rowCount === 1;
    }
    // Close the row first, then undo the debit: two reconcilers racing cannot both refund.
    if (s.status === "processing") {
      const r = await this.d.pool.query("UPDATE app_spend SET status = 'voided', reason = $2 WHERE spend_id = $1 AND status = 'processing'", [spendId, out.reason]);
      if (r.rowCount !== 1) return false;
      this.emitSpend(spendId);
    }
    const tx = await this.d.ledger.findByKey(`spend:${spendId}`);
    if (tx) await this.d.wallets.voidSpend(spendId, tx);
    return true;
  }

  /** Puts a note on a processing spend (e.g. "needs review"), visible to the agent in list_transactions. */
  async noteSpend(spendId: string, reason: string): Promise<void> {
    await this.d.pool.query("UPDATE app_spend SET reason = $2 WHERE spend_id = $1 AND status = 'processing'", [spendId, reason]);
  }

  // ---------- helpers ----------

  /** Today's UTC day, as [start, end). The same day boundary AgentWallets uses. */
  private today(): [Date, Date] {
    const start = new Date(`${this.now().toISOString().slice(0, 10)}T00:00:00Z`);
    return [start, new Date(start.getTime() + 86_400_000)];
  }

  /** Approved and still-processing spends today: a processing payment's money is held until it settles. */
  private async spentToday(cardId: string, agentId: string, db: Pick<pg.Pool, "query"> = this.d.pool): Promise<number> {
    const [start, end] = this.today();
    const r = await db.query(
      "SELECT COALESCE(sum(amount_cents), 0) AS s FROM app_spend WHERE card_id = $1 AND agent_id = $2 AND status IN ('approved', 'processing') AND created_at >= $3 AND created_at < $4",
      [cardId, agentId, start, end],
    );
    return num(r.rows[0].s);
  }

  private async spends(cardId: string, agentId: string, limit: number): Promise<SpendView[]> {
    const r = await this.d.pool.query("SELECT * FROM app_spend WHERE card_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3", [cardId, agentId, limit]);
    return r.rows.map(spendView);
  }

  private async user(userId: string) {
    const r = await this.d.pool.query("SELECT * FROM app_user WHERE id = $1", [userId]);
    if (!r.rows[0]) throw new AppError(404, "user not found");
    return r.rows[0];
  }

  private async cardOf(userId: string) {
    return (await this.d.pool.query("SELECT * FROM app_card WHERE user_id = $1", [userId])).rows[0];
  }

  private async requireCard(userId: string) {
    const card = await this.cardOf(userId);
    if (!card) throw new AppError(409, "no card yet: complete KYC first");
    return card;
  }

  private async requireAgent(cardId: string, agentId: string) {
    const r = await this.d.pool.query("SELECT * FROM app_agent WHERE card_id = $1 AND agent_id = $2", [cardId, agentId]);
    if (!r.rows[0]) throw new AppError(404, "agent not found");
    return r.rows[0];
  }

  /** Users with KYC still in review, for the background poller. */
  async pendingKycUsers(): Promise<string[]> {
    const r = await this.d.pool.query(
      "SELECT u.id FROM app_user u LEFT JOIN app_card c ON c.user_id = u.id WHERE u.kyc_reference IS NOT NULL AND c.card_id IS NULL AND u.kyc_status <> 'Rejected'",
    );
    return r.rows.map((x) => x.id);
  }
}

/** The card said no for certain (vs a timeout, 429 or 5xx, where it may have been charged). */
function isDefiniteRefusal(e: unknown): boolean {
  if (e instanceof MidenBusinessError) return true;
  return e instanceof MidenApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
}

/** Owner-chosen agent limits must fit the card's and make sense together; say so instead of silently capping. */
function checkAgentLimits(p: SpendPolicy, card: { per_txn_cents: string | number; daily_cents: string | number }): void {
  if (p.perTransactionCents > num(card.per_txn_cents)) throw new AppError(400, `per-payment limit can be at most ${usd(num(card.per_txn_cents))}, the card's limit`);
  if (p.dailyCents > num(card.daily_cents)) throw new AppError(400, `daily limit can be at most ${usd(num(card.daily_cents))}, the card's limit`);
  if (p.perTransactionCents > p.dailyCents) throw new AppError(400, "per-payment limit cannot be more than the daily limit");
}

/** Why money is sitting in holding instead of moving to the card, or null if it will move on the next run. */
function holdingReason(holdingCents: number, roomCents: number, capCents: number): string | null {
  if (holdingCents <= 0) return null;
  if (roomCents < MIN_FUNDING_CENTS) return `this card reached its lifetime funding limit of ${usd(capCents)}; verify your identity for a higher tier to move it`;
  if (holdingCents < MIN_FUNDING_CENTS) return `below the ${usd(MIN_FUNDING_CENTS)} minimum top-up; it moves once more arrives`;
  if (holdingCents > roomCents) return `${usd(roomCents)} more can move before this card's lifetime funding limit of ${usd(capCents)}; the rest stays here`;
  return null;
}

function policyOf(a: { per_txn_cents: string | number; daily_cents: string | number; allowed_mccs: string[] | null }): SpendPolicy {
  const p: SpendPolicy = { perTransactionCents: num(a.per_txn_cents), dailyCents: num(a.daily_cents) };
  if (a.allowed_mccs && a.allowed_mccs.length) p.allowedMccs = a.allowed_mccs;
  return p;
}

function spendView(s: Record<string, unknown>): SpendView {
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

function parseMccs(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const list = Array.isArray(v) ? v : String(v).split(",");
  const mccs = list.map((x) => String(x).trim()).filter(Boolean);
  if (!mccs.every((m) => /^\d{4}$/.test(m))) throw new AppError(400, "allowedMccs must be 4-digit codes");
  return mccs.length ? mccs : undefined;
}

function validateKyc(k: Partial<IndividualKyc>): IndividualKyc {
  const t = (v: unknown, what: string) => requireText(v, what, 120);
  const dob = t(k.dateOfBirth, "dateOfBirth");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new AppError(400, "dateOfBirth must be YYYY-MM-DD");
  const idType = t(k.idType, "idType").toUpperCase();
  if (!ID_TYPES.has(idType)) throw new AppError(400, `idType must be one of ${[...ID_TYPES].join(", ")}`);
  const image = requireText(k.idFrontImage, "idFrontImage", 1_500_000);
  if (!/^data:image\/(png|jpe?g);base64,/.test(image)) throw new AppError(400, "idFrontImage must be a PNG or JPEG data URI");
  const a = k.address ?? ({} as IndividualKyc["address"]);
  return {
    firstName: t(k.firstName, "firstName"), lastName: t(k.lastName, "lastName"), dateOfBirth: dob, idType,
    idNumber: t(k.idNumber, "idNumber"), idFrontImage: image, phone: t(k.phone, "phone"), email: t(k.email, "email"),
    address: { address1: t(a.address1, "address1"), city: t(a.city, "city"), state: t(a.state, "state"), zipcode: t(a.zipcode, "zipcode"), country: t(a.country, "country") },
  };
}

function midenMessage(e: MidenApiError): string {
  try {
    const b = JSON.parse(e.body) as { responseMessage?: string; message?: string; responseCode?: string };
    return `${b.responseCode ? b.responseCode + " " : ""}${b.responseMessage ?? b.message ?? `HTTP ${e.status}`}`;
  } catch {
    return `HTTP ${e.status}`;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
