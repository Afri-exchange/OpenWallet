import type { CardLifecycle } from "../virtualCards/CardLifecycle.js";
import type { Tier, TieredCard, TieredCardIssuer } from "../../lib/services/tiers.js";
import { referenceFor } from "../funding/MidenWalletFunding.js";
import type { MidenClient } from "../../lib/clients/cardIssuing/miden/MidenClient.js";

/** Individual Card KYC by ID document (docs/miden-api.md). `idType` is Miden's uppercase enum, e.g. PASSPORT. */
export interface IndividualKyc {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  idType: string;
  idNumber: string;
  /** Base64 or data URI. */
  idFrontImage: string;
  phone: string;
  email: string;
  address: { address1: string; city: string; state: string; zipcode: string; country: string };
}

export type OnboardingState =
  | { state: "pending"; status: string }
  | { state: "rejected" }
  | { state: "active"; card: TieredCard };

interface SubmitResponse {
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
}

/**
 * Signup: the user does a quick Card KYC, and once Miden approves it they get one real card under their own
 * customer. Agents then use that card through wallet sub-balances, so they need no KYC of their own.
 * Identity data is passed straight to Miden and never logged or kept here.
 */
export class Onboarding {
  private readonly cards = new Map<string, Promise<TieredCard>>();

  constructor(
    private readonly miden: MidenClient,
    private readonly lifecycle: CardLifecycle,
    private readonly issuer: TieredCardIssuer,
  ) {}

  /** clientReference is stable per user, so a retry cannot create a second customer. */
  static kycReference(userId: string): string {
    return `kyc-${userId}`;
  }

  async submitKyc(userId: string, kyc: IndividualKyc): Promise<void> {
    const clientReference = Onboarding.kycReference(userId);
    const res = await this.miden.request<SubmitResponse>(
      "POST",
      "/api/v1/cards/kyc-submit",
      {
        customerType: "Individual",
        phone: kyc.phone,
        email: kyc.email,
        clientReference,
        individualKyc: {
          firstName: kyc.firstName,
          lastName: kyc.lastName,
          dateOfBirth: kyc.dateOfBirth,
          idType: kyc.idType,
          idNumber: kyc.idNumber,
          idFrontImage: kyc.idFrontImage,
          address: kyc.address,
        },
      },
      { reference: referenceFor(`kyc:${userId}`) },
    );
    if (res.isSuccessful !== true || (res.responseCode !== "000" && res.responseCode !== "00")) {
      throw new Error(`Miden KYC submit failed: ${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`);
    }
  }

  /** Checks the user's KYC and, once approved, issues their single card (concurrent calls share one issuance). */
  async status(userId: string, tier: Tier = "quick"): Promise<OnboardingState> {
    const existing = this.cards.get(userId);
    if (existing) return { state: "active", card: await existing };
    const kyc = await this.lifecycle.kycStatus(Onboarding.kycReference(userId));
    if (kyc.status === "Rejected") return { state: "rejected" };
    if (kyc.status !== "Approved" || !kyc.customerId || !kyc.kycToken) return { state: "pending", status: kyc.status };
    let issuing = this.cards.get(userId);
    if (!issuing) {
      issuing = this.issuer.issue(userId, { customerId: kyc.customerId, kycToken: kyc.kycToken }, tier, `card-${userId}`);
      this.cards.set(userId, issuing);
      // A failed issuance must not block a later retry (same clientReference keeps Miden idempotent).
      issuing.catch(() => this.cards.delete(userId));
    }
    return { state: "active", card: await issuing };
  }
}
