/**
 * Stablecoin base units -> ledger cents. Floors to whole cents; the remainder is returned as dust
 * (never credited, never rounded up). bigint end to end: no JS number touches the amount.
 *
 * `decimals` is the on-chain precision of the (asset, chain) pair, e.g. 6 for USDC on Ethereum,
 * 18 for USDT on BNB Chain.
 *
 * A positive amount below one cent returns `{ cents: 0, dustBase: base }`; the caller must record the
 * dust and post no ledger tx.
 */
export function baseUnitsToCents(base: bigint, decimals: number): { cents: number; dustBase: bigint } {
  if (typeof base !== "bigint") throw new TypeError("base units must be a bigint");
  if (!Number.isInteger(decimals) || decimals < 2) {
    throw new RangeError(`decimals must be an integer >= 2, got ${decimals}`);
  }
  if (base <= 0n) throw new RangeError("base units must be positive");

  const divisor = 10n ** BigInt(decimals - 2);
  const cents = base / divisor;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("amount exceeds Number.MAX_SAFE_INTEGER cents");
  }
  return { cents: Number(cents), dustBase: base % divisor };
}
