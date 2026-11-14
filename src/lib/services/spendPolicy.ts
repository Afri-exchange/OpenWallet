/** Spend controls attached to an agent's card. Enforced here before any call to Miden. */
export interface SpendPolicy {
  perTransactionCents: number;
  dailyCents: number;
  allowedMccs?: string[];
}

export interface AuthorizationAttempt {
  amountCents: number;
  mcc?: string;
  spentTodayCents: number;
}

export function evaluate(policy: SpendPolicy, a: AuthorizationAttempt): { ok: true } | { ok: false; reason: string } {
  if (a.amountCents > policy.perTransactionCents) return { ok: false, reason: "per-transaction limit exceeded" };
  if (a.spentTodayCents + a.amountCents > policy.dailyCents) return { ok: false, reason: "daily limit exceeded" };
  if (policy.allowedMccs && (!a.mcc || !policy.allowedMccs.includes(a.mcc))) return { ok: false, reason: "merchant category not allowed" };
  return { ok: true };
}
