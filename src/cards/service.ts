import type { FundingReceipt, FundingSource, Stablecoin } from "../funding/types.js";
import type { MidenClient } from "../miden/client.js";
import { referenceFor } from "../funding/miden-wallet.js";
import { decryptSecureCardDetails, fetchFullCardDetails, type DetailKeys } from "../miden/card-details.js";
import type { CardDetails, CardVault, CaptureSource } from "../vault/vault.js";
import { evaluate, type SpendPolicy } from "./policy.js";

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

export interface AgentCard {
  id: string;
  agentId: string;
  policy: SpendPolicy;
  /** Set when the service has a vault: whether the full card details are in it. */
  detailsCaptured?: boolean;
}

/** Card-detail capture at issue: decrypt Miden's secureCardDetails and seal it into the vault. */
export interface CaptureConfig {
  vault: Pick<CardVault, "put" | "has">;
  keys: DetailKeys;
  /** Never receives card data: only ids, last4 and scheme names. */
  log?: (msg: string) => void;
}

/** Output of Miden Card KYC (docs/miden-api.md). An agent cannot be the KYC subject: this is a verified person or business. */
export interface CardholderKyc {
  customerId: string;
  kycToken: string;
}

interface IssueResponse {
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
  data?: { cardId?: string; firstSix?: string; lastFour?: string; secureCardDetails?: string };
}

/**
 * Issues cards for agents and tops them up from stablecoins.
 * Issuance is POST api/v2/cards/issue (docs/miden-api.md); shapes are from the docs, UNCONFIRMED against the sandbox.
 */
export class CardService {
  /** Approved spend per card per UTC day, in memory only (lost on restart). */
  private readonly spent = new Map<string, Map<string, number>>();

  constructor(
    private readonly miden: MidenClient,
    private readonly funding: FundingSource,
    private readonly now: () => Date = () => new Date(),
    private readonly capture?: CaptureConfig,
  ) {}

  /**
   * `clientReference` must be stable per card (not per agent): it is sent as both the
   * body `clientReference` and, hashed, the Reference header, so retrying an issuance
   * after a timeout with the same value cannot create a second card.
   * With a CaptureConfig, `secureCardDetails` (encrypted PAN/CVV) is decrypted and sealed into the vault
   * before this returns; it is never returned, logged or kept. Capture failing does not fail the issue (the
   * card exists and the wallet was debited): the card comes back with detailsCaptured: false, and
   * captureDetails() retries through the full-PAN endpoint.
   */
  async issue(agentId: string, policy: SpendPolicy, kyc: CardholderKyc, clientReference: string, initialBalanceDollars = 1): Promise<AgentCard> {
    const res = await this.miden.request<IssueResponse>(
      "POST",
      "/api/v2/cards/issue",
      {
        customerId: kyc.customerId,
        kycToken: kyc.kycToken,
        cardBrand: "Visa",
        // Sandbox rejects less than 1 (responseCode 117, "Card Balance Less that Initial Minimum Card of 1").
        initialBalance: initialBalanceDollars,
        clientReference,
        walletCurrency: "USD",
        cardCurrency: "USD",
        // Major units (dollars), as strings per the docs example. UNCONFIRMED.
        cardLimits: {
          dailyLimit: (policy.dailyCents / 100).toFixed(2),
          transactionLimit: (policy.perTransactionCents / 100).toFixed(2),
        },
        ...(policy.allowedMccs ? { whiteListedMccs: policy.allowedMccs } : {}),
      },
      // Sandbox issuance sometimes takes over 15s; a timeout is safe (same Reference on retry) but noisy.
      { reference: referenceFor(`issue:${clientReference}`), timeoutMs: 60_000 },
    );
    // HTTP 2xx does not imply business success.
    const cardId = res.data?.cardId;
    if (res.isSuccessful !== true || res.responseCode !== "000" || !cardId) {
      throw new Error(`Miden card issuance failed: ${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`);
    }
    if (!this.capture) return { id: cardId, agentId, policy };
    const detailsCaptured = await this.captureFromIssue(cardId, res.data!).catch((e: unknown) => {
      this.capture!.log?.(`card ${cardId}: capture at issue failed: ${(e as Error).message}`);
      return false;
    }) || (await this.captureDetails(cardId));
    return { id: cardId, agentId, policy, detailsCaptured };
  }

  private async captureFromIssue(cardId: string, data: NonNullable<IssueResponse["data"]>): Promise<boolean> {
    if (typeof data.secureCardDetails !== "string" || !data.secureCardDetails) throw new Error("issue response had no secureCardDetails");
    const { details, scheme } = decryptSecureCardDetails(data.secureCardDetails, this.capture!.keys);
    const lastFour = details.pan.slice(-4);
    await this.store(cardId, details, scheme, "issue", data);
    await this.addBillingDetails(cardId, lastFour);
    return true;
  }

  /**
   * secureCardDetails has no cardholder name or billing address, which hosted checkouts ask for; full-PAN has both
   * (sandbox, 2026-10-19). Best effort: the issue-time capture already stands if this fails.
   */
  private async addBillingDetails(cardId: string, lastFour: string): Promise<void> {
    try {
      const { details, scheme } = await fetchFullCardDetails(this.miden, cardId, this.capture!.keys);
      if (!details.nameOnCard && !details.billingZip && !details.billingAddress) return;
      await this.store(cardId, details, scheme, "full-pan", { lastFour });
    } catch (e) {
      this.capture!.log?.(`card ${cardId}: no billing details from full-PAN: ${(e as Error).message}`);
    }
  }

  /**
   * Captures a card's details from GET .../full-pan if the vault does not have them yet. Safe to repeat.
   * Returns false (and logs why) when Miden will not give them, e.g. a program without full-PAN access.
   */
  async captureDetails(cardId: string, opts: { refreshLastFour?: string } = {}): Promise<boolean> {
    const c = this.capture;
    if (!c) throw new Error("CardService has no vault configured");
    try {
      if (await c.vault.has(cardId)) {
        if (!opts.refreshLastFour) return true;
        // Re-reads the cardholder fields (e.g. a billing address added after the card was captured). The caller
        // passes the stored card's lastFour (this service cannot reveal), so a full-PAN answer for another card is refused.
        await this.addBillingDetails(cardId, opts.refreshLastFour);
        return true;
      }
      const { details, scheme } = await fetchFullCardDetails(this.miden, cardId, c.keys);
      return await this.store(cardId, details, scheme, "full-pan");
    } catch (e) {
      c.log?.(`card ${cardId}: capture from full-PAN failed: ${(e as Error).message}`);
      return false;
    }
  }

  private async store(cardId: string, details: CardDetails, scheme: string, source: CaptureSource, issued?: { firstSix?: string; lastFour?: string }): Promise<boolean> {
    try {
      // The issue response's masked PAN is an independent check that we decrypted this card, not garbage.
      if (issued?.lastFour && !details.pan.endsWith(issued.lastFour)) throw new Error("decrypted PAN does not match the issued lastFour");
      if (issued?.firstSix && !details.pan.startsWith(issued.firstSix)) throw new Error("decrypted PAN does not match the issued firstSix");
      await this.capture!.vault.put(cardId, details, { source });
      this.capture!.log?.(`card ${cardId}: details captured (${source}, ${scheme}, ****${details.pan.slice(-4)})`);
      return true;
    } finally {
      details.pan = details.cvv = "";
    }
  }

  topUp(card: AgentCard, amountCents: number, asset: Stablecoin, idempotencyKey: string): Promise<FundingReceipt> {
    return this.funding.fund({ cardId: card.id, amountCents, asset, idempotencyKey });
  }

  /**
   * Checks a spend attempt against the card's policy and, if approved, records it
   * against today's total. Synchronous, so concurrent attempts cannot both pass the
   * daily limit within one process.
   */
  authorize(card: AgentCard, amountCents: number, mcc?: string): AuthorizationResult {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return { ok: false, reason: "amount must be a positive whole number of cents" };
    }
    const day = this.now().toISOString().slice(0, 10);
    const days = this.spent.get(card.id) ?? new Map<string, number>();
    const spentTodayCents = days.get(day) ?? 0;
    const result = evaluate(card.policy, { amountCents, mcc, spentTodayCents });
    if (result.ok) {
      days.set(day, spentTodayCents + amountCents);
      // Keep every day seen until a newer one arrives, so a clock stepping back still finds its day;
      // only drop days more than 2 behind the latest.
      const latest = [...days.keys()].sort().at(-1)!;
      const cutoff = new Date(Date.parse(latest) - 2 * 86_400_000).toISOString().slice(0, 10);
      for (const d of days.keys()) if (d < cutoff) days.delete(d);
      this.spent.set(card.id, days);
    }
    return result;
  }
}
