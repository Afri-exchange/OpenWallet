/**
 * Double-entry, append-only ledger. Amounts are integer USD cents.
 * Every transaction's postings sum to zero; balances are derived, never edited.
 * Storage is behind LedgerStore (MemoryLedgerStore for tests, PgLedgerStore in production); all validation lives here.
 */
import { DuplicateKeyError, type LedgerStore, type StoreTx } from "../../domain/repositories/LedgerStore.js";
import { MemoryLedgerStore } from "../../db/repositories/MemoryLedgerStore.js";

export interface Posting {
  account: string;
  /** Signed cents: positive credits the account, negative debits it. */
  amountCents: number;
}

export interface LedgerTransaction {
  seq: number;
  idempotencyKey: string;
  kind: string;
  /** External reference, e.g. an on-chain tx hash or a Miden transfer id. */
  reference?: string;
  /** Set only on kind "reversal": the seq of the transaction this one undoes. */
  reversesSeq?: number;
  postings: Posting[];
  createdAt: string;
}

export interface NewTransaction {
  idempotencyKey: string;
  kind: string;
  reference?: string;
  postings: Posting[];
}

/** Account ids are `<namespace>:<name>`. Only external and fee accounts may go negative. */
const MAY_GO_NEGATIVE = new Set(["external", "fees"]);
const ACCOUNT_ID = /^[a-z][a-z_]*:\S+$/;

export const accounts = {
  external: (asset: string) => `external:${asset}`,
  holding: (cardId: string) => `holding:${cardId}`,
  /** Funds reserved for an in-flight fiat funding, not yet confirmed on the card. */
  pending: (cardId: string) => `pending:${cardId}`,
  card: (cardId: string) => `card:${cardId}`,
  /** An agent's sub-balance carved out of its owner's card balance. Never negative. */
  agent: (cardId: string, agentId: string) => `agent:${cardId}:${agentId}`,
  fees: () => "fees:fees",
  /** The card network: where card spends go, and where checkout charges come back from to us as merchant of record. */
  merchant: () => "external:merchant",
  /** What we owe a checkout merchant. Never negative. */
  merchantBalance: (merchantId: string) => `merchant:${merchantId}`,
  /** A merchant's payouts reserved but not yet confirmed sent. */
  payoutPending: (merchantId: string) => `payout_pending:${merchantId}`,
  /** Money paid out to merchants (bank or chain). */
  payouts: () => "external:payout",
};

export class LedgerError extends Error {}

/** Kinds only the typed helpers may write; raw post() rejects them. */
const RESERVED_KINDS = new Set(["deposit", "spend", "reversal"]);
const isReservedKind = (k: string) =>
  RESERVED_KINDS.has(k) || k.startsWith("funding") || k.startsWith("agent_") || k.startsWith("checkout_") || k.startsWith("payout");

export interface LedgerOptions {
  /** Stablecoins that may be credited by confirmDeposit. Default USDC and USDT. */
  assets?: string[];
}

interface Options {
  /** Raw post(): only adjustments between allowed external accounts and fees, never reserved kinds. */
  restricted?: boolean;
  reversesSeq?: number;
  /** Runs inside the transaction after the accounts are locked, before the idempotency check. */
  guard?: (tx: StoreTx) => Promise<void>;
}

export class Ledger {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly store: LedgerStore = new MemoryLedgerStore(),
    opts: LedgerOptions = {},
  ) {
    this.assets = new Set(opts.assets ?? ["USDC", "USDT"]);
  }

  private readonly assets: Set<string>;

  /**
   * Raw adjustment between external:<allowed asset | merchant> and fees:* accounts. It cannot touch
   * holding/pending/card accounts or write the kinds the typed helpers own. Replaying the same key
   * and content returns the original.
   */
  async post(tx: NewTransaction): Promise<LedgerTransaction> {
    return this.run(tx, { restricted: true });
  }

  async balance(account: string): Promise<number> {
    return this.store.balance(account);
  }

  /** The transaction written under `idempotencyKey`, if any (e.g. `spend:<spendId>`). */
  async findByKey(idempotencyKey: string): Promise<LedgerTransaction | undefined> {
    const tx = await this.store.transaction((st) => st.findByKey(idempotencyKey));
    return tx ? freeze(tx) : undefined;
  }

  /** Transactions that touch the account, oldest first. */
  async history(account: string): Promise<LedgerTransaction[]> {
    return (await this.store.history(account)).map(freeze);
  }

  /** Stablecoin deposit confirmed on-chain: credit USD 1:1 to the card's holding account. */
  async confirmDeposit(args: { chain: string; asset: string; cardId: string; amountCents: number; txHash: string; logIndex: number }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireText(args.chain, "chain");
    if (!this.assets.has(args.asset)) throw new LedgerError(`unsupported asset: ${String(args.asset)}`);
    requireText(args.txHash, "txHash");
    if (!Number.isSafeInteger(args.logIndex) || args.logIndex < 0) throw new LedgerError("logIndex must be a non-negative integer");
    // One on-chain transfer = chain + tx hash + log index. Hash case must not matter.
    const key = `deposit:${args.chain.trim().toLowerCase()}:${args.txHash.trim().toLowerCase()}:${args.logIndex}`;
    return this.run({
      idempotencyKey: key,
      kind: "deposit",
      reference: args.txHash.trim().toLowerCase(),
      postings: [
        { account: accounts.external(args.asset), amountCents: -args.amountCents },
        { account: accounts.holding(args.cardId), amountCents: args.amountCents },
      ],
    }, {});
  }

  /**
   * Step 1 of funding, BEFORE any fiat is sent: moves funds from holding to pending. The second of
   * two concurrent reserves that together exceed the holding balance fails here.
   */
  async reserveFunding(args: { cardId: string; amountCents: number; fundingId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireText(args.fundingId, "fundingId");
    return this.run(reservation(args), {});
  }

  /** Step 2a: fiat landed on the card. Moves the reserved funds to the card balance, minus any fee. */
  async completeFunding(args: { cardId: string; amountCents: number; feeCents?: number; fundingId: string }): Promise<LedgerTransaction> {
    const fee = args.feeCents ?? 0;
    requirePositive(args.amountCents, "amountCents");
    requireText(args.fundingId, "fundingId");
    if (!Number.isSafeInteger(fee) || fee < 0 || fee >= args.amountCents) throw new LedgerError("feeCents must be an integer >= 0 and < amountCents");
    const postings: Posting[] = [
      { account: accounts.pending(args.cardId), amountCents: -args.amountCents },
      { account: accounts.card(args.cardId), amountCents: args.amountCents - fee },
    ];
    if (fee > 0) postings.push({ account: accounts.fees(), amountCents: fee });
    return this.run({ idempotencyKey: `funding-complete:${args.fundingId}`, kind: "funding", reference: args.fundingId, postings }, {
      guard: (tx) => this.requireOpenReservation(tx, args, "funding-release"),
    });
  }

  /** Step 2b: the fiat transfer failed or was abandoned. Returns the reserved funds to holding. */
  async releaseFunding(args: { cardId: string; amountCents: number; fundingId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireText(args.fundingId, "fundingId");
    return this.run({
      idempotencyKey: `funding-release:${args.fundingId}`,
      kind: "funding_release",
      reference: args.fundingId,
      postings: [
        { account: accounts.pending(args.cardId), amountCents: -args.amountCents },
        { account: accounts.holding(args.cardId), amountCents: args.amountCents },
      ],
    }, { guard: (tx) => this.requireOpenReservation(tx, args, "funding-complete") });
  }

  /** Card spend: leaves the ledger toward the merchant. */
  async recordSpend(args: { cardId: string; amountCents: number; spendId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireText(args.spendId, "spendId");
    return this.run({
      idempotencyKey: `spend:${args.spendId}`,
      kind: "spend",
      reference: args.spendId,
      postings: [
        { account: accounts.card(args.cardId), amountCents: -args.amountCents },
        { account: accounts.merchant(), amountCents: args.amountCents },
      ],
    }, {});
  }

  /** Moves money from the owner's card balance into one agent's sub-balance. Fails if the card balance is short. */
  async allocateToAgent(args: { cardId: string; agentId: string; amountCents: number; allocationId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireAgentId(args.agentId);
    requireText(args.allocationId, "allocationId");
    return this.run({
      idempotencyKey: `agent-allocate:${args.allocationId}`,
      kind: "agent_allocate",
      reference: args.allocationId,
      postings: [
        { account: accounts.card(args.cardId), amountCents: -args.amountCents },
        { account: accounts.agent(args.cardId, args.agentId), amountCents: args.amountCents },
      ],
    }, {});
  }

  /** Returns unspent sub-balance to the owner's card balance. Fails if the agent has less than that. */
  async returnFromAgent(args: { cardId: string; agentId: string; amountCents: number; returnId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireAgentId(args.agentId);
    requireText(args.returnId, "returnId");
    return this.run({
      idempotencyKey: `agent-return:${args.returnId}`,
      kind: "agent_return",
      reference: args.returnId,
      postings: [
        { account: accounts.agent(args.cardId, args.agentId), amountCents: -args.amountCents },
        { account: accounts.card(args.cardId), amountCents: args.amountCents },
      ],
    }, {});
  }

  /** An agent's spend leaves its sub-balance toward the merchant. The agent cannot spend more than it holds. */
  async recordAgentSpend(args: { cardId: string; agentId: string; amountCents: number; spendId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireAgentId(args.agentId);
    requireText(args.spendId, "spendId");
    return this.run({
      idempotencyKey: `spend:${args.spendId}`,
      kind: "spend",
      reference: args.spendId,
      postings: [
        { account: accounts.agent(args.cardId, args.agentId), amountCents: -args.amountCents },
        { account: accounts.merchant(), amountCents: args.amountCents },
      ],
    }, {});
  }

  /**
   * A paid checkout's charge comes back from the card network to the merchant's balance. One key per
   * checkout, so a replay or a second (late) approval can never credit the merchant twice.
   */
  async settleCheckout(args: { merchantId: string; checkoutId: string; amountCents: number }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireAgentId(args.merchantId);
    requireText(args.checkoutId, "checkoutId");
    return this.run({
      idempotencyKey: `checkout-settle:${args.checkoutId}`,
      kind: "checkout_settle",
      reference: args.checkoutId,
      postings: [
        { account: accounts.merchant(), amountCents: -args.amountCents },
        { account: accounts.merchantBalance(args.merchantId), amountCents: args.amountCents },
      ],
    }, {});
  }

  /**
   * Takes a refunded checkout back out of the merchant's balance (toward the card network, which returns it
   * to the payer's card). One refund per checkout, at most what it settled. Fails rather than go negative if the
   * merchant has already been paid out.
   */
  async refundCheckout(args: { merchantId: string; checkoutId: string; amountCents: number }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireAgentId(args.merchantId);
    requireText(args.checkoutId, "checkoutId");
    return this.run({
      idempotencyKey: `checkout-refund:${args.checkoutId}`,
      kind: "checkout_refund",
      reference: args.checkoutId,
      postings: [
        { account: accounts.merchantBalance(args.merchantId), amountCents: -args.amountCents },
        { account: accounts.merchant(), amountCents: args.amountCents },
      ],
    }, {
      guard: async (tx) => {
        const settled = await tx.findByKey(`checkout-settle:${args.checkoutId}`);
        const credited = settled?.postings.find((p) => p.account === accounts.merchantBalance(args.merchantId))?.amountCents ?? 0;
        if (args.amountCents > credited) throw new LedgerError(`checkout ${args.checkoutId} was not settled to this merchant for that much`);
      },
    });
  }

  /** Step 1 of a payout, BEFORE anything is sent: merchant balance -> pending. Fails if the balance is short. */
  async reservePayout(args: { merchantId: string; amountCents: number; payoutId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireAgentId(args.merchantId);
    requireText(args.payoutId, "payoutId");
    return this.run(payoutReservation(args), {});
  }

  /** Step 2a: the payout rail confirmed the money left. */
  async completePayout(args: { merchantId: string; amountCents: number; payoutId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireText(args.payoutId, "payoutId");
    return this.run({
      idempotencyKey: `payout-complete:${args.payoutId}`,
      kind: "payout",
      reference: args.payoutId,
      postings: [
        { account: accounts.payoutPending(args.merchantId), amountCents: -args.amountCents },
        { account: accounts.payouts(), amountCents: args.amountCents },
      ],
    }, { guard: (tx) => this.requireOpenPayout(tx, args, "payout-release") });
  }

  /** Step 2b: the rail definitely failed (never on a lost answer). Returns the funds to the merchant's balance. */
  async releasePayout(args: { merchantId: string; amountCents: number; payoutId: string }): Promise<LedgerTransaction> {
    requirePositive(args.amountCents, "amountCents");
    requireText(args.payoutId, "payoutId");
    return this.run({
      idempotencyKey: `payout-release:${args.payoutId}`,
      kind: "payout_release",
      reference: args.payoutId,
      postings: [
        { account: accounts.payoutPending(args.merchantId), amountCents: -args.amountCents },
        { account: accounts.merchantBalance(args.merchantId), amountCents: args.amountCents },
      ],
    }, { guard: (tx) => this.requireOpenPayout(tx, args, "payout-complete") });
  }

  /**
   * Compensating transaction that negates every posting of `seq`. Allowed once per transaction,
   * never on a reversal, and still subject to the overdraft rules (it fails if the money has moved on).
   */
  async reverse(args: { seq: number }): Promise<LedgerTransaction> {
    if (!Number.isSafeInteger(args.seq) || args.seq < 1) throw new LedgerError("seq must be a positive integer");
    const original = await this.store.transaction((tx) => tx.findBySeq(args.seq));
    if (!original) throw new LedgerError(`no transaction with seq ${args.seq}`);
    if (original.kind === "reversal") throw new LedgerError("a reversal cannot be reversed");
    // Funding steps are settled by their own terminal keys; undoing one would strand the funds.
    if (original.kind.startsWith("funding")) throw new LedgerError("funding transactions cannot be reversed");
    if (original.kind.startsWith("payout")) throw new LedgerError("payout transactions cannot be reversed");
    // Checkout settles and refunds are keyed once per checkout (and settled_seq marks them done); a reversal would
    // double-credit a refunded merchant or silently drop a sale that sync never re-credits.
    if (original.kind.startsWith("checkout_")) throw new LedgerError("checkout transactions cannot be reversed");
    return this.run({
      idempotencyKey: `reversal:${original.seq}`,
      kind: "reversal",
      reference: String(original.seq),
      postings: original.postings.map((p) => ({ account: p.account, amountCents: -p.amountCents })),
    }, { reversesSeq: original.seq });
  }

  /** The reserve must exist for the same card and amount, and the other terminal step must not have happened. */
  private async requireOpenReservation(tx: StoreTx, args: { cardId: string; amountCents: number; fundingId: string }, otherTerminal: string): Promise<void> {
    const reserved = await tx.findByKey(`funding-reserve:${args.fundingId}`);
    if (!reserved || !samePostings(reserved.postings, reservation(args).postings)) {
      throw new LedgerError(`no matching reservation for funding ${args.fundingId}`);
    }
    if (await tx.findByKey(`${otherTerminal}:${args.fundingId}`)) {
      throw new LedgerError(`funding ${args.fundingId} was already settled by ${otherTerminal}`);
    }
  }

  private async requireOpenPayout(tx: StoreTx, args: { merchantId: string; amountCents: number; payoutId: string }, otherTerminal: string): Promise<void> {
    const reserved = await tx.findByKey(`payout-reserve:${args.payoutId}`);
    if (!reserved || !samePostings(reserved.postings, payoutReservation(args).postings)) {
      throw new LedgerError(`no matching reservation for payout ${args.payoutId}`);
    }
    if (await tx.findByKey(`${otherTerminal}:${args.payoutId}`)) {
      throw new LedgerError(`payout ${args.payoutId} was already settled by ${otherTerminal}`);
    }
  }

  private rawAllowed(account: string): boolean {
    const [ns, name] = [account.split(":")[0]!, account.slice(account.indexOf(":") + 1)];
    return ns === "fees" || (ns === "external" && (this.assets.has(name) || name === "merchant"));
  }

  private async run(tx: NewTransaction, opts: Options): Promise<LedgerTransaction> {
    const postings = tx.postings.map((p) => ({ account: p.account, amountCents: p.amountCents }));
    requireText(tx.idempotencyKey, "idempotencyKey");
    requireText(tx.kind, "kind");
    if (postings.length < 2) throw new LedgerError("a transaction needs at least two postings");
    let sum = 0;
    const delta = new Map<string, number>();
    for (const p of postings) {
      if (typeof p.account !== "string" || !ACCOUNT_ID.test(p.account)) throw new LedgerError(`bad account id: ${String(p.account)}`);
      if (!Number.isSafeInteger(p.amountCents) || p.amountCents === 0) throw new LedgerError("posting amount must be a non-zero integer");
      sum += p.amountCents;
      if (!Number.isSafeInteger(sum)) throw new LedgerError("posting sum outside safe integer range");
      delta.set(p.account, (delta.get(p.account) ?? 0) + p.amountCents);
    }
    if (sum !== 0) throw new LedgerError("postings must sum to zero");
    if (opts.restricted) {
      if (isReservedKind(tx.kind)) throw new LedgerError(`kind ${tx.kind} is reserved for the typed ledger methods`);
      for (const account of delta.keys()) if (!this.rawAllowed(account)) throw new LedgerError(`raw post cannot touch ${account}`);
    }

    try {
      return freeze(await this.store.transaction(async (st) => {
        const balances = await st.lock([...delta.keys()]);
        await opts.guard?.(st);
        const existing = await st.findByKey(tx.idempotencyKey);
        if (existing) {
          if (existing.kind !== tx.kind || existing.reference !== tx.reference || !samePostings(existing.postings, postings)) {
            throw new LedgerError(`idempotency key reused with different content: ${tx.idempotencyKey}`);
          }
          return existing;
        }
        for (const [account, d] of delta) {
          const next = (balances.get(account) ?? 0) + d;
          if (!Number.isSafeInteger(next)) throw new LedgerError(`balance of ${account} outside safe integer range`);
          if (next < 0 && !MAY_GO_NEGATIVE.has(account.split(":")[0]!)) throw new LedgerError(`insufficient funds in ${account}`);
        }
        return st.append({
          idempotencyKey: tx.idempotencyKey,
          kind: tx.kind,
          ...(tx.reference !== undefined ? { reference: tx.reference } : {}),
          ...(opts.reversesSeq !== undefined ? { reversesSeq: opts.reversesSeq } : {}),
          postings,
          createdAt: this.now().toISOString(),
        });
      }));
    } catch (e) {
      if (e instanceof DuplicateKeyError) throw new LedgerError(`idempotency key reused with different content: ${tx.idempotencyKey}`);
      if (e instanceof Error && e.constructor.name === "OverdraftError") throw new LedgerError("insufficient funds");
      throw e;
    }
  }
}

function reservation(args: { cardId: string; amountCents: number; fundingId: string }): NewTransaction {
  return {
    idempotencyKey: `funding-reserve:${args.fundingId}`,
    kind: "funding_reserve",
    reference: args.fundingId,
    postings: [
      { account: accounts.holding(args.cardId), amountCents: -args.amountCents },
      { account: accounts.pending(args.cardId), amountCents: args.amountCents },
    ],
  };
}

function payoutReservation(args: { merchantId: string; amountCents: number; payoutId: string }): NewTransaction {
  return {
    idempotencyKey: `payout-reserve:${args.payoutId}`,
    kind: "payout_reserve",
    reference: args.payoutId,
    postings: [
      { account: accounts.merchantBalance(args.merchantId), amountCents: -args.amountCents },
      { account: accounts.payoutPending(args.merchantId), amountCents: args.amountCents },
    ],
  };
}

function requirePositive(n: number, name: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new LedgerError(`${name} must be a positive integer number of cents`);
}

/** No ":" or whitespace, so `agent:<card>:<agent>` cannot be confused with another pair. */
function requireAgentId(v: unknown): void {
  if (typeof v !== "string" || !/^[A-Za-z0-9_.-]+$/.test(v)) throw new LedgerError("agentId must be letters, digits, '_', '.' or '-'");
}

function requireText(v: unknown, name: string): void {
  if (typeof v !== "string" || v.trim() === "") throw new LedgerError(`${name} must be a non-empty string`);
}

/** Order-insensitive comparison. */
function samePostings(a: Posting[], b: Posting[]): boolean {
  const canon = (ps: Posting[]) => ps.map((p) => `${p.account}|${p.amountCents}`).sort().join(",");
  return a.length === b.length && canon(a) === canon(b);
}

function freeze(tx: LedgerTransaction): LedgerTransaction {
  return Object.freeze({ ...tx, postings: Object.freeze(tx.postings.map((p) => Object.freeze({ ...p }))) as Posting[] });
}
