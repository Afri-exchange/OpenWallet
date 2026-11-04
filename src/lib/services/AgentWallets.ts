import type { Ledger, LedgerTransaction } from "./Ledger.js";
import { accounts } from "./Ledger.js";
import { evaluate, type SpendPolicy } from "./spendPolicy.js";

export type AgentSpendResult = { ok: true; tx: LedgerTransaction } | { ok: false; reason: string };

interface AgentRecord {
  cardId: string;
  policy: SpendPolicy;
}

/**
 * Agent wallets: sub-balances carved out of the owner's one real card, each with its own spend policy.
 * The owner's KYC backs the card, so agents need none of their own. Enforcement is ours: Miden only sees
 * the one card, so a spend that bypasses `spend()` (card details used directly) is not stopped here.
 * Balances live in the ledger; per-day totals are in memory only (per process). CardholderInteractor enforces the
 * daily limits in Postgres instead and passes dailyCheckedByCaller.
 */
export class AgentWallets {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly spent = new Map<string, Map<string, number>>();
  /** Spends already counted (spendId -> where), so retrying a spendId replays the ledger entry without counting it twice. */
  private readonly counted = new Map<string, { key: string; day: string; amountCents: number }>();

  constructor(
    private readonly ledger: Ledger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Registers an agent under a card. Re-registering the same id with a different card is refused. */
  create(cardId: string, agentId: string, policy: SpendPolicy): void {
    const key = `${cardId}:${agentId}`;
    if (!/^[A-Za-z0-9_.-]+$/.test(agentId)) throw new Error("agentId must be letters, digits, '_', '.' or '-'");
    if (this.agents.has(key)) throw new Error(`agent ${agentId} already exists on card ${cardId}`);
    this.agents.set(key, { cardId, policy });
  }

  /** The agent's policy, or undefined if it is not registered. */
  policy(cardId: string, agentId: string): SpendPolicy | undefined {
    return this.agents.get(`${cardId}:${agentId}`)?.policy;
  }

  /** Replaces an agent's policy. Today's spend still counts against the new daily limit. */
  setPolicy(cardId: string, agentId: string, policy: SpendPolicy): void {
    this.require(cardId, agentId).policy = policy;
  }

  /**
   * Rebuilds the per-day totals after a restart from a persisted spend log (approved, not voided spends).
   * Call once per spend, after create() and before serving traffic.
   */
  restoreSpend(cardId: string, agentId: string, spendId: string, amountCents: number, at: Date): void {
    this.require(cardId, agentId);
    if (this.counted.has(spendId)) return;
    const key = `${cardId}:${agentId}`;
    const day = at.toISOString().slice(0, 10);
    const days = this.spent.get(key) ?? new Map<string, number>();
    days.set(day, (days.get(day) ?? 0) + amountCents);
    this.spent.set(key, days);
    this.counted.set(spendId, { key, day, amountCents });
  }

  /**
   * Undoes an approved spend the card network then refused: reverses the ledger entry (money back to the
   * agent) and takes it off the daily total. Safe to call twice.
   */
  async voidSpend(spendId: string, tx: LedgerTransaction): Promise<void> {
    await this.ledger.reverse({ seq: tx.seq });
    const c = this.counted.get(spendId);
    if (!c) return;
    const days = this.spent.get(c.key);
    if (days) days.set(c.day, Math.max(0, (days.get(c.day) ?? 0) - c.amountCents));
    this.counted.delete(spendId);
  }

  balance(cardId: string, agentId: string): Promise<number> {
    return this.ledger.balance(accounts.agent(cardId, agentId));
  }

  /** Gives the agent money from the owner's card balance. `allocationId` makes a retry safe. */
  async fund(cardId: string, agentId: string, amountCents: number, allocationId: string): Promise<LedgerTransaction> {
    this.require(cardId, agentId);
    return this.ledger.allocateToAgent({ cardId, agentId, amountCents, allocationId });
  }

  /** Takes unspent money back to the owner's card balance. */
  async reclaim(cardId: string, agentId: string, amountCents: number, returnId: string): Promise<LedgerTransaction> {
    this.require(cardId, agentId);
    return this.ledger.returnFromAgent({ cardId, agentId, amountCents, returnId });
  }

  /**
   * Checks the agent's policy, then debits its sub-balance. The policy's daily total counts only approved
   * spends. A ledger failure (insufficient sub-balance) leaves the daily total untouched.
   * `opts.dailyCheckedByCaller`: the caller already enforced the daily limit against a shared store (the
   * in-memory total here is per process, so with several processes it would be wrong).
   */
  async spend(cardId: string, agentId: string, amountCents: number, spendId: string, mcc?: string, opts: { dailyCheckedByCaller?: boolean } = {}): Promise<AgentSpendResult> {
    const agent = this.require(cardId, agentId);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, reason: "amount must be a positive whole number of cents" };
    const key = `${cardId}:${agentId}`;
    const day = this.now().toISOString().slice(0, 10);
    const days = this.spent.get(key) ?? new Map<string, number>();
    const spentTodayCents = days.get(day) ?? 0;
    if (this.counted.has(spendId)) return { ok: true, tx: await this.ledger.recordAgentSpend({ cardId, agentId, amountCents, spendId }) };
    const verdict = evaluate(agent.policy, { amountCents, mcc, spentTodayCents: opts.dailyCheckedByCaller ? 0 : spentTodayCents });
    if (!verdict.ok) return verdict;
    // Reserve the day's total before awaiting so concurrent spends cannot both pass the daily limit.
    days.set(day, spentTodayCents + amountCents);
    this.spent.set(key, days);
    try {
      const tx = await this.ledger.recordAgentSpend({ cardId, agentId, amountCents, spendId });
      this.counted.set(spendId, { key, day, amountCents });
      return { ok: true, tx };
    } catch (e) {
      days.set(day, (days.get(day) ?? 0) - amountCents);
      if (e instanceof Error && /insufficient funds/.test(e.message)) return { ok: false, reason: "insufficient agent balance" };
      throw e;
    }
  }

  private require(cardId: string, agentId: string): AgentRecord {
    const a = this.agents.get(`${cardId}:${agentId}`);
    if (!a) throw new Error(`unknown agent ${agentId} on card ${cardId}`);
    return a;
  }
}
