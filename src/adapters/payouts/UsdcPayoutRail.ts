import { encodeFunctionData, keccak256, type Hex, type LocalAccount } from "viem";
import { BASE_SEPOLIA_USDC, type Rpc } from "../deposits/BaseUsdcWatcher.js";

/**
 * Sends USDC payouts from our payout account. TESTNET ONLY (Base Sepolia): mainnet needs real key custody
 * and a settlement hold released by card capture, neither of which exists yet, so the constructor refuses it.
 *
 * Never sends twice: a transfer is signed with an explicit nonce and the caller stores the signed bytes
 * BEFORE broadcasting. A retry rebroadcasts the same bytes (same nonce, same hash), which the chain can
 * include at most once.
 */

export const BASE_SEPOLIA_CHAIN_ID = 84532;
const ERC20_TRANSFER = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
/** USDC has 6 decimals: one cent is 10^4 base units. */
const BASE_UNITS_PER_CENT = 10_000n;

export interface SignedTransfer {
  txHash: string;
  rawTx: string;
  nonce: number;
}

export type TransferState =
  /** Mined with success and `confirmations` deep: the merchant has the money. */
  | { state: "confirmed" }
  /** Mined and reverted, `confirmations` deep: nothing moved. A definite failure. */
  | { state: "reverted" }
  /** Not (deep enough) on chain yet. Rebroadcast and wait; never treat as failed. */
  | { state: "pending" }
  /** Our nonce was used by a different transaction, so this one can never be mined. A person must look. */
  | { state: "replaced" };

export interface UsdcPayoutRailOptions {
  rpc: Rpc;
  account: LocalAccount;
  chainId?: number;
  token?: string;
  /** Blocks on top of the transfer's block before it counts. Default 5, like deposits. */
  confirmations?: number;
}

const quantity = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-f]+$/i.test(v)) throw new Error(`RPC returned a bad ${what}: ${String(v)}`);
  return BigInt(v);
};

export class UsdcPayoutRail {
  readonly chainId: number;
  readonly token: string;
  private readonly confirmations: number;

  constructor(private readonly o: UsdcPayoutRailOptions) {
    this.chainId = o.chainId ?? BASE_SEPOLIA_CHAIN_ID;
    if (this.chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error("USDC payouts are testnet only (Base Sepolia) until key custody and a settlement hold exist");
    this.token = (o.token ?? BASE_SEPOLIA_USDC).toLowerCase();
    this.confirmations = o.confirmations ?? 5;
  }

  get from(): string {
    return this.o.account.address.toLowerCase();
  }

  /** The payout account's USDC balance, in cents (floored). */
  async balanceCents(): Promise<number> {
    const data = `0x70a08231${this.from.slice(2).padStart(64, "0")}`;
    const r = quantity(await this.o.rpc("eth_call", [{ to: this.token, data }, "latest"]), "balance");
    return Number(r / BASE_UNITS_PER_CENT);
  }

  /** Enough USDC for `amountCents` and enough ETH for a transfer's gas (100k gas at today's price). */
  async funded(amountCents: number): Promise<boolean> {
    const [usdc, wei, price] = await Promise.all([
      this.balanceCents(),
      this.o.rpc("eth_getBalance", [this.from, "latest"]),
      this.o.rpc("eth_gasPrice", []),
    ]);
    return usdc >= amountCents && quantity(wei, "balance") >= quantity(price, "gas price") * 100_000n;
  }

  /**
   * Signs (does not send) a transfer of `amountCents` to `to`, at the account's next nonce. Throws if the
   * transfer would revert now (e.g. the payout account is short of USDC or gas): nothing was signed then.
   */
  async sign(args: { to: string; amountCents: number }): Promise<SignedTransfer> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(args.to)) throw new Error("bad payout address");
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) throw new Error("amountCents must be a positive integer");
    const data = encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [args.to as Hex, BigInt(args.amountCents) * BASE_UNITS_PER_CENT] });
    const call = { from: this.from, to: this.token, data };
    const [nonceQ, gasQ, tipQ, block] = await Promise.all([
      this.o.rpc("eth_getTransactionCount", [this.from, "pending"]),
      this.o.rpc("eth_estimateGas", [call]),
      this.o.rpc("eth_maxPriorityFeePerGas", []),
      this.o.rpc("eth_getBlockByNumber", ["latest", false]) as Promise<{ baseFeePerGas?: unknown } | null>,
    ]);
    const nonce = Number(quantity(nonceQ, "nonce"));
    const gas = (quantity(gasQ, "gas estimate") * 13n) / 10n; // headroom over the estimate
    const tip = quantity(tipQ, "priority fee");
    const baseFee = quantity(block?.baseFeePerGas, "base fee");
    const rawTx = await this.o.account.signTransaction({
      type: "eip1559", chainId: this.chainId, nonce, to: this.token as Hex, data, value: 0n, gas,
      maxPriorityFeePerGas: tip, maxFeePerGas: baseFee * 3n + tip,
    });
    return { txHash: keccak256(rawTx), rawTx, nonce };
  }

  /** Sends signed bytes. Safe to repeat: "already known" and a nonce the same tx already used are not errors. */
  async broadcast(rawTx: string): Promise<void> {
    try {
      await this.o.rpc("eth_sendRawTransaction", [rawTx]);
    } catch (e) {
      if (/already known|known transaction|nonce too low|already imported/i.test((e as Error).message)) return;
      throw e;
    }
  }

  async state(t: { txHash: string; nonce: number }): Promise<TransferState> {
    const receipt = (await this.o.rpc("eth_getTransactionReceipt", [t.txHash])) as { status?: unknown; blockNumber?: unknown } | null;
    if (receipt) {
      const head = quantity(await this.o.rpc("eth_blockNumber", []), "block number");
      if (head - quantity(receipt.blockNumber, "block number") < BigInt(this.confirmations)) return { state: "pending" };
      return { state: quantity(receipt.status, "receipt status") === 1n ? "confirmed" : "reverted" };
    }
    // No receipt: if the account's mined nonce has moved past ours, a different transaction took the slot.
    const mined = Number(quantity(await this.o.rpc("eth_getTransactionCount", [this.from, "latest"]), "nonce"));
    if (mined > t.nonce) {
      // Re-check: the receipt may have landed between the two reads.
      if (await this.o.rpc("eth_getTransactionReceipt", [t.txHash])) return { state: "pending" };
      return { state: "replaced" };
    }
    return { state: "pending" };
  }
}
