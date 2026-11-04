import type { MidenClient } from "../../lib/clients/cardIssuing/miden/MidenClient.js";

/** Poll-based reads for the card lifecycle, used instead of webhooks. Shapes are from docs/miden-api.md. */

export interface CardTransaction {
  id?: number;
  cardId?: string;
  transactionType?: string;
  transactionStatus?: string;
  transactionReference?: string;
  transactionAmount?: number;
  merchantName?: string;
  merchantMcc?: string;
  merchantMid?: string;
  /** Sandbox shows UTC without a zone suffix, e.g. "2026-10-19T14:11:54.689346". */
  transactionTime?: string;
  authCode?: string;
}

interface Envelope {
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
}

/** Miden answered 2xx but said no (isSuccessful false or a non-success code): a definite refusal, not a timeout. */
export class MidenBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MidenBusinessError";
  }
}

/** HTTP 2xx does not imply business success. KYC answers "00" in the docs example, everything else "000". */
function check<T extends Envelope>(what: string, res: T): T {
  if (res.isSuccessful !== true || (res.responseCode !== "000" && res.responseCode !== "00")) {
    throw new MidenBusinessError(`Miden ${what} failed: ${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`);
  }
  return res;
}

export type KycStatus = "Initiated" | "Pending" | "Approved" | "Rejected";

export class CardLifecycle {
  constructor(private readonly miden: MidenClient) {}

  /** GET api/v1/cards/kyc/client-reference/{clientReference}. `kycToken` is a credential: callers must not log it. */
  async kycStatus(clientReference: string): Promise<{ status: string; customerId?: string; kycToken?: string }> {
    const res = check(
      "KYC lookup",
      await this.miden.request<Envelope & { kycStatus?: string; customerId?: string; kycToken?: string }>(
        "GET",
        `/api/v1/cards/kyc/client-reference/${encodeURIComponent(clientReference)}`,
      ),
    );
    return { status: res.kycStatus ?? "Unknown", customerId: res.customerId, kycToken: res.kycToken };
  }

  /** GET api/v1/cards/balance/{cardId}, in dollars. */
  async cardBalance(cardId: string): Promise<number> {
    const res = check(
      "card balance",
      await this.miden.request<Envelope & { availableBalance?: number }>("GET", `/api/v1/cards/balance/${encodeURIComponent(cardId)}`),
    );
    if (typeof res.availableBalance !== "number") throw new Error("Miden card balance response had no availableBalance");
    return res.availableBalance;
  }

  /** GET api/v1/cards/transactions for one card, optionally filtered by type. */
  async transactions(cardId: string, type?: string, pageSize = 50): Promise<CardTransaction[]> {
    const q = new URLSearchParams({ CardId: cardId, pageNumber: "1", pageSize: String(pageSize) });
    if (type) q.set("TransactionType", type);
    const res = check(
      "card transactions",
      await this.miden.request<Envelope & { transactions?: CardTransaction[] }>("GET", `/api/v1/cards/transactions?${q}`),
    );
    return res.transactions ?? [];
  }

  /**
   * POST api/v1/mock/authorization: sandbox-only simulated purchase. Returns Miden's `authorizationId`.
   * The mock is NOT idempotent: replaying the same Reference charges again (seen 2026-10-19), so never
   * retry it blindly. `mid` comes back as `merchantMid` on the card's Authorization transaction, which is
   * how a caller finds out what happened after a timeout.
   */
  async simulateAuthorization(
    args: { cardId: string; amountDollars: number; mcc?: string; merchantName?: string; approve?: boolean; mid?: string },
    opts: { reference?: string } = {},
  ): Promise<string | undefined> {
    const res = check(
      "simulated authorization",
      await this.miden.request<Envelope & { authorizationId?: string }>("POST", "/api/v1/mock/authorization", {
        cardId: args.cardId,
        amount: args.amountDollars,
        authorizationAmount: args.amountDollars,
        mid: args.mid ?? "720022841966601",
        authorizationCurrency: "USD",
        currency: "USD",
        status: args.approve === false ? "Decline" : "Approved",
        authMessage: args.approve === false ? "No sufficient funds" : "Approved or completed successfully",
        transactionOptions: { additionalData: "simulation" },
        cardAcceptor: {
          name: args.merchantName ?? "Agent Cards Sandbox Merchant",
          address: "1 Test Street",
          city: "Testville",
          state: "CA",
          zip: "94000",
          mcc: args.mcc ?? "5734",
          country: "US",
        },
      }, opts),
    );
    return res.authorizationId;
  }
}

/** Calls `read` every `intervalMs` until `done(value)` holds or `timeoutMs` passes; throws on timeout. */
export async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 3_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() + intervalMs > deadline) throw new Error(`poll timed out after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}
