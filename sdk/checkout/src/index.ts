// @agent-cards/checkout: accept payments from AI agents that hold an Agent Card wallet.
//
//   Merchant (server side, secret key mk_...):  AgentCardsCheckout  create / retrieve / list / cancel / waitForPayment
//   Merchant page:                               checkoutButton(), checkoutMetaTag()
//   Agent (no MCP client, agent token ak_...):   AgentCardsAgent     getCheckout / payCheckout / wallet
//
// No dependencies; needs a global fetch (Node 18+, Deno, Bun, browsers for the agent client).

export type CheckoutStatus = "open" | "processing" | "paid" | "canceled" | "expired";
export type PaymentStatus = "processing" | "approved" | "declined" | "voided";

export interface Checkout {
  checkoutId: string;
  status: CheckoutStatus;
  amountCents: number;
  currency: "USD";
  description: string;
  reference: string | null;
  mcc: string | null;
  metadata: Record<string, unknown> | null;
  /** Send the agent here, or show it as a "Pay with Agent Card" link. */
  checkoutUrl: string;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  payment: { paymentId: string; status: PaymentStatus } | null;
  /** "failed" when the last agent's attempt did not go through; the checkout is still open. */
  lastAttempt: "failed" | null;
  /** Set when a person must look at the payment. Do not fulfil while it is set. */
  underReview: string | null;
}

export interface CreateCheckoutParams {
  /** Price in US cents, e.g. 1299 for $12.99. */
  amountCents: number;
  /** What is being bought; the agent and its owner see this. */
  description: string;
  /** Your order id, echoed back. */
  reference?: string;
  /** 4-digit merchant category code; defaults to the one on your merchant account. */
  mcc?: string;
  /** Default 1800 (30 minutes); 60 to 86400. */
  expiresInSeconds?: number;
  /** Yours only; never shown to agents. At most 4 KB of JSON. */
  metadata?: Record<string, unknown>;
  /** Strongly recommended: a retry with the same key returns the same checkout instead of a second one. */
  idempotencyKey?: string;
}

/** What agents (and anyone holding the id) see. */
export interface PublicCheckout {
  checkoutId: string;
  merchant: string;
  description: string;
  amountCents: number;
  currency: "USD";
  status: CheckoutStatus;
  expiresAt: string;
}

export interface Payment {
  spendId: string;
  amountCents: number;
  merchant: string;
  mcc: string | null;
  status: PaymentStatus;
  reason: string | null;
  createdAt: string;
}

export interface CheckoutPayResult {
  checkout: PublicCheckout;
  payment: Payment;
}

/** What you are owed: paid checkouts, minus payouts. */
export interface Balance {
  /** What a payout can draw on. */
  availableCents: number;
  /** Payouts requested and not yet confirmed sent. */
  pendingPayoutCents: number;
  currency: "USD";
}

export type PayoutStatus = "requested" | "sending" | "sent" | "failed";

export interface Payout {
  payoutId: string;
  amountCents: number;
  currency: "USD";
  /**
   * "requested": reserved from your balance, queued. "sending": the USDC transfer is on its way (see txHash).
   * "sent": confirmed on chain. "failed": nothing arrived, and the money went back to your balance.
   */
  status: PayoutStatus;
  /** USDC on this chain ("base-sepolia" for now), to this address; fixed when the payout was requested. */
  chain: string | null;
  destination: string | null;
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
  /** Payouts to payoutAddress are allowed from this time: a new address waits, in case your key was stolen. */
  payoutAddressUsableFrom: string | null;
}

export class AgentCardsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AgentCardsError";
  }
}

export interface ClientOptions {
  /** The agent-cards server, e.g. http://127.0.0.1:8787 (sandbox). Must be https unless it is localhost. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

class Http {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly token: string | undefined, private readonly o: ClientOptions) {
    this.base = o.baseUrl.replace(/\/$/, "");
    const { protocol, hostname } = new URL(this.base);
    if (token && protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
      throw new Error(`refusing to send a secret over plain http to ${hostname}: use https`);
    }
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new AgentCardsError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as T;
  }
}

const seg = (id: string) => encodeURIComponent(id);
const FINAL: ReadonlySet<CheckoutStatus> = new Set(["paid", "canceled", "expired"]);

/** Merchant client. Keep the secret key on your server; never ship it to a browser or an agent. */
export class AgentCardsCheckout {
  private readonly http: Http;

  constructor(opts: ClientOptions & { secretKey: string }) {
    if (!opts.secretKey?.startsWith("mk_")) throw new Error("secretKey must be a merchant secret key (mk_...)");
    this.http = new Http(opts.secretKey, opts);
  }

  /** Creates a merchant account. The secret key is returned once; store it like a password. */
  static signup(opts: ClientOptions, params: { name: string; email: string; mcc?: string }): Promise<{ merchantId: string; name: string; secretKey: string }> {
    return new Http(undefined, opts).call("POST", "/merchant/v1/signup", params);
  }

  me(): Promise<MerchantProfile> {
    return this.http.call("GET", "/merchant/v1/me");
  }

  /**
   * Where payouts go: your EVM address, paid in USDC on Base Sepolia (testnet) for now. A new address can be
   * paid only after a waiting period (see payoutAddressUsableFrom); payouts already requested are not redirected.
   */
  setPayoutAddress(address: string): Promise<MerchantProfile> {
    return this.http.call("POST", "/merchant/v1/payout-address", { address });
  }

  /** Replaces the secret key; the old one stops working at once. Build a new client with the result. */
  rotateKey(): Promise<{ secretKey: string }> {
    return this.http.call("POST", "/merchant/v1/key");
  }

  createCheckout(params: CreateCheckoutParams): Promise<Checkout> {
    return this.http.call("POST", "/merchant/v1/checkouts", params);
  }

  /** The source of truth for whether you were paid: fulfil the order only when status is "paid". */
  retrieveCheckout(checkoutId: string): Promise<Checkout> {
    return this.http.call("GET", `/merchant/v1/checkouts/${seg(checkoutId)}`);
  }

  listCheckouts(opts: { limit?: number } = {}): Promise<Checkout[]> {
    return this.http.call("GET", `/merchant/v1/checkouts${opts.limit ? `?limit=${opts.limit}` : ""}`);
  }

  /** Only an open checkout can be canceled. */
  cancelCheckout(checkoutId: string): Promise<Checkout> {
    return this.http.call("POST", `/merchant/v1/checkouts/${seg(checkoutId)}/cancel`);
  }

  /** Your balance: each paid checkout is credited here. */
  balance(): Promise<Balance> {
    return this.http.call("GET", "/merchant/v1/balance");
  }

  /**
   * Asks for a payout from your available balance; the amount is reserved at once. Pass an idempotencyKey so
   * a retry never asks twice. Needs a payout address (setPayoutAddress); sent as USDC, usually within minutes.
   */
  requestPayout(params: { amountCents: number; idempotencyKey?: string }): Promise<Payout> {
    return this.http.call("POST", "/merchant/v1/payouts", params);
  }

  listPayouts(opts: { limit?: number } = {}): Promise<Payout[]> {
    return this.http.call("GET", `/merchant/v1/payouts${opts.limit ? `?limit=${opts.limit}` : ""}`);
  }

  /**
   * Polls until the checkout is paid, canceled or expired, and returns it. A checkout that is still open or
   * processing when `timeoutMs` runs out is returned as it is; check `status` before fulfilling.
   */
  async waitForPayment(checkoutId: string, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<Checkout> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const interval = Math.max(500, opts.intervalMs ?? 2_000);
    for (;;) {
      const c = await this.retrieveCheckout(checkoutId);
      if (FINAL.has(c.status) || Date.now() + interval > deadline) return c;
      await sleep(interval, opts.signal);
    }
  }
}

/** Agent client, for agents that do not use the MCP server. The token is the agent's own (ak_...). */
export class AgentCardsAgent {
  private readonly http: Http;

  constructor(opts: ClientOptions & { token: string }) {
    if (!opts.token?.startsWith("ak_")) throw new Error("token must be an agent token (ak_...)");
    this.http = new Http(opts.token, opts);
  }

  wallet(): Promise<{ balanceCents: number; limits: { perTransactionCents: number; dailyCents: number; allowedMccs: string[] | null }; remainingTodayCents: number }> {
    return this.http.call("GET", "/agent/v1/wallet");
  }

  getCheckout(checkoutId: string): Promise<PublicCheckout> {
    return this.http.call("GET", `/agent/v1/checkouts/${seg(parseCheckoutId(checkoutId))}`);
  }

  /**
   * Pays at the merchant's price. Safe to retry: it never pays the same checkout twice. Pass the price you
   * expect as maxAmountCents and a dearer checkout is refused without charging.
   */
  payCheckout(checkoutId: string, opts: { maxAmountCents?: number } = {}): Promise<CheckoutPayResult> {
    return this.http.call("POST", `/agent/v1/checkouts/${seg(parseCheckoutId(checkoutId))}/pay`, opts);
  }
}

/** Accepts a checkout id or a /pay/cs_... link and returns the id. */
export function parseCheckoutId(idOrUrl: string): string {
  const m = /(cs_[a-f0-9]{32})(?:[/?#]|$)/.exec(idOrUrl.trim());
  if (!m) throw new Error("not an Agent Card checkout id or link");
  return m[1]!;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * A "Pay with Agent Card" link for your checkout page, plus machine-readable attributes so an agent
 * browsing the page can find the checkout. Server-render it; it needs no script.
 */
export function checkoutButton(checkout: Pick<Checkout, "checkoutId" | "checkoutUrl" | "amountCents">, opts: { label?: string } = {}): string {
  const label = opts.label ?? `Pay $${(checkout.amountCents / 100).toFixed(2)} with Agent Card`;
  return `<a href="${esc(checkout.checkoutUrl)}" data-agent-cards-checkout="${esc(checkout.checkoutId)}" rel="payment" ` +
    `style="display:inline-block;padding:.7em 1.2em;border-radius:10px;background:#111;color:#fff;text-decoration:none;font:600 15px/1.2 system-ui,sans-serif">${esc(label)}</a>`;
}

/** For the page's <head>: lets an agent discover the checkout without parsing the body. */
export function checkoutMetaTag(checkout: Pick<Checkout, "checkoutId">): string {
  return `<meta name="agent-cards-checkout" content="${esc(checkout.checkoutId)}">`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}
