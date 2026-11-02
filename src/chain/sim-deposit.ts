import { baseUnitsToCents } from "../ledger/units.js";

/** Sentinel that opts a deposit id into the sandbox simulator. A real transaction hash never starts with it. */
export const SIM_DEPOSIT_PREFIX = "sim_";

export interface SimDepositHint { address: string; asset: "USDC" | "USDT"; amountCents: number; id: string }

/**
 * Parses `sim_<address>_<USDC|USDT>_<amount>[_<nonce>]`: <address> is 0x + 40 hex, <amount> is dollars with up to
 * 6 decimals and at least one cent. The id is the idempotency key, so repeating it credits once; add a nonce
 * (letters and digits) to make the same address and amount count again. Returns null for anything else.
 */
export function parseSimDeposit(id: string): SimDepositHint | null {
  if (!id.startsWith(SIM_DEPOSIT_PREFIX)) return null;
  const [address, rawAsset, rawAmount, nonce, ...extra] = id.slice(SIM_DEPOSIT_PREFIX.length).split("_");
  if (extra.length > 0 || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const asset = rawAsset?.toUpperCase();
  if (asset !== "USDC" && asset !== "USDT") return null;
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(rawAmount ?? "");
  if (!m) return null;
  if (nonce !== undefined && !/^[A-Za-z0-9]{1,32}$/.test(nonce)) return null;
  const base = BigInt(m[1]! + (m[2] ?? "").padEnd(6, "0"));
  if (base === 0n) return null;
  const { cents } = baseUnitsToCents(base, 6);
  if (cents === 0) return null;
  return { address: address.toLowerCase(), asset, amountCents: cents, id: id.toLowerCase() };
}
