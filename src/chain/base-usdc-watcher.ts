import type { Ledger } from "../ledger/ledger.js";
import { baseUnitsToCents } from "../ledger/units.js";

/** Native USDC on Base mainnet (Circle). 6 decimals. */
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** Circle's test USDC on Base Sepolia (chain 84532). 6 decimals. Free from faucet.circle.com. */
export const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/** Circle's test USDC on Ethereum Sepolia (chain 11155111). 6 decimals. faucet.circle.com selects this network by default. */
export const ETHEREUM_SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_DECIMALS = 6;

/** JSON-RPC call. `jsonRpc(url)` is the default; tests pass a fake. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

/** Where the watcher remembers the last block it fully credited. Persist it; memory loses it on restart. */
export interface CursorStore {
  get(): Promise<number | undefined>;
  set(block: number): Promise<void>;
}

export class MemoryCursor implements CursorStore {
  constructor(private block?: number) {}
  async get() { return this.block; }
  async set(block: number) { this.block = block; }
}

/** Deposit addresses we issued, each tied to one card. A deposit address always has a card behind it. */
export interface DepositAddresses {
  /** Every address to watch, any case. */
  all(): Promise<string[]>;
  /** The card an address funds, or undefined if it is not ours. */
  cardFor(address: string): Promise<string | undefined>;
}

export interface Dust { cardId: string; txHash: string; logIndex: number; dustBase: bigint }

export interface WatcherOptions {
  rpc: Rpc;
  ledger: Ledger;
  addresses: DepositAddresses;
  cursor: CursorStore;
  /** First block to scan when the cursor is empty. Required then: we never guess, and never scan from 0. */
  startBlock?: number;
  /** Blocks behind head before a transfer is credited. Default 10 (about 20s on Base). */
  confirmations?: number;
  /**
   * "finalized" credits only up to the chain's `finalized` block tag (reorg-proof; on Base that lags the head
   * by many minutes). Use it wherever a credit is irreversible, i.e. production: a card top-up cannot be undone.
   * Default "confirmations" (head - confirmations), which is fine for testnet.
   */
  finality?: "confirmations" | "finalized";
  /** Max blocks per eth_getLogs call. Providers cap this; default 2000. */
  maxRange?: number;
  /** Max addresses per eth_getLogs topic filter. Default 500. */
  maxAddresses?: number;
  /** Sub-cent remainders (never credited). A replayed range reports them again: key them by txHash+logIndex. */
  onDust?: (d: Dust) => void | Promise<void>;
  token?: string;
  /** Ledger chain label; part of the deposit idempotency key. Default "base"; use "base-sepolia" for testnet. */
  chain?: string;
}

export interface TickResult { from: number; to: number; credited: number; skipped: number }

const hex = (n: number) => `0x${n.toString(16)}`;
const topicFor = (addr: string) => `0x${"0".repeat(24)}${addr.toLowerCase().replace(/^0x/, "")}`;
const addressFromTopic = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

function parseQuantity(value: unknown, what: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`bad ${what} from RPC: ${String(value)}`);
  const n = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} out of range: ${value}`);
  return n;
}

/**
 * Credits USDC sent to our deposit addresses on Base. Each tick scans (cursor, head - confirmations],
 * credits every matching Transfer through `ledger.confirmDeposit`, and only then moves the cursor. A
 * crash mid-range replays the range on the next tick; the ledger's chain+txHash+logIndex key makes the
 * replay a no-op, so nothing is credited twice and nothing is skipped.
 *
 * An address added while the watcher runs is seen from the next tick, for blocks after the cursor.
 * Add it before showing it to a user; use `rescan` to backfill one that was missed.
 */
export class BaseUsdcWatcher {
  private readonly confirmations: number;
  private readonly maxRange: number;
  private readonly maxAddresses: number;
  private readonly token: string;
  private readonly chain: string;

  constructor(private readonly o: WatcherOptions) {
    this.confirmations = o.confirmations ?? 10;
    this.maxRange = o.maxRange ?? 2000;
    this.maxAddresses = o.maxAddresses ?? 500;
    this.token = (o.token ?? BASE_USDC).toLowerCase();
    this.chain = o.chain ?? "base";
    if (!Number.isInteger(this.confirmations) || this.confirmations < 1) throw new Error("confirmations must be >= 1");
    if (!Number.isInteger(this.maxRange) || this.maxRange < 1) throw new Error("maxRange must be >= 1");
    if (!Number.isInteger(this.maxAddresses) || this.maxAddresses < 1) throw new Error("maxAddresses must be >= 1");
  }

  /** Highest block it is safe to credit from. */
  private async safeHead(): Promise<number> {
    if (this.o.finality === "finalized") {
      const block = (await this.o.rpc("eth_getBlockByNumber", ["finalized", false])) as { number?: unknown } | null;
      return parseQuantity(block?.number, "finalized block number");
    }
    return parseQuantity(await this.o.rpc("eth_blockNumber", []), "block number") - this.confirmations;
  }

  /** One pass, at most `maxRange` blocks. Returns undefined when there is nothing confirmed to scan. */
  async tick(): Promise<TickResult | undefined> {
    const safe = await this.safeHead();
    const last = await this.o.cursor.get();
    let from: number;
    if (last !== undefined) from = last + 1;
    else if (this.o.startBlock !== undefined) from = this.o.startBlock;
    else throw new Error("cursor is empty and no startBlock given");
    if (from > safe) return undefined;
    const to = Math.min(safe, from + this.maxRange - 1);
    const counts = await this.scan(from, to);
    await this.o.cursor.set(to);
    return { from, to, ...counts };
  }

  /** Re-reads a closed block range and credits anything missed. Safe to repeat; does not move the cursor. */
  async rescan(from: number, to: number): Promise<{ credited: number; skipped: number }> {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new Error("bad range");
    if (to > (await this.safeHead())) throw new Error("range includes unconfirmed blocks");
    const total = { credited: 0, skipped: 0 };
    for (let start = from; start <= to; start += this.maxRange) {
      const r = await this.scan(start, Math.min(to, start + this.maxRange - 1));
      total.credited += r.credited;
      total.skipped += r.skipped;
    }
    return total;
  }

  /** Loops `tick` until aborted, sleeping `intervalMs` when caught up. Errors are reported and retried. */
  async run(signal: AbortSignal, opts: { intervalMs?: number; onError?: (e: unknown) => void } = {}): Promise<void> {
    const intervalMs = opts.intervalMs ?? 4_000;
    while (!signal.aborted) {
      let caughtUp = true;
      try {
        const r = await this.tick();
        caughtUp = r === undefined;
      } catch (e) {
        opts.onError?.(e);
      }
      if (caughtUp && !signal.aborted) await sleep(intervalMs, signal);
    }
  }

  private async scan(from: number, to: number): Promise<{ credited: number; skipped: number }> {
    const addrs = [...new Set((await this.o.addresses.all()).map((a) => a.toLowerCase()))];
    let credited = 0;
    let skipped = 0;
    for (let i = 0; i < addrs.length; i += this.maxAddresses) {
      const logs = (await this.o.rpc("eth_getLogs", [{
        address: this.token,
        fromBlock: hex(from),
        toBlock: hex(to),
        topics: [TRANSFER_TOPIC, null, addrs.slice(i, i + this.maxAddresses).map(topicFor)],
      }])) as RpcLog[];
      if (!Array.isArray(logs)) throw new Error("eth_getLogs did not return an array");
      for (const log of logs) (await this.credit(log, from, to)) ? credited++ : skipped++;
    }
    return { credited, skipped };
  }

  /** True if the ledger was credited (or already had it). Anything we cannot trust throws or is skipped. */
  private async credit(log: RpcLog, from: number, to: number): Promise<boolean> {
    // Never trust the provider's filter: re-check every field we rely on.
    if (log.removed) return false;
    if (log.address?.toLowerCase() !== this.token) return false;
    if (log.topics?.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
    const block = parseQuantity(log.blockNumber, "log blockNumber");
    if (block < from || block > to) throw new Error(`RPC returned a log outside ${from}-${to}: block ${block}`);
    const cardId = await this.o.addresses.cardFor(addressFromTopic(log.topics[2]!));
    if (!cardId) return false;
    if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) throw new Error(`bad Transfer data in ${log.transactionHash}`);
    const base = BigInt(log.data);
    if (base === 0n) return false;
    const logIndex = parseQuantity(log.logIndex, "logIndex");
    const { cents, dustBase } = baseUnitsToCents(base, USDC_DECIMALS);
    if (dustBase > 0n) await this.o.onDust?.({ cardId, txHash: log.transactionHash, logIndex, dustBase });
    if (cents === 0) return false;
    await this.o.ledger.confirmDeposit({ chain: this.chain, asset: "USDC", cardId, amountCents: cents, txHash: log.transactionHash, logIndex });
    return true;
  }
}

/** Minimal JSON-RPC over fetch. The URL usually holds a provider key: do not log it. */
export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error) throw new Error(`RPC ${method} error ${body.error.code ?? "?"}: ${body.error.message ?? ""}`);
    return body.result;
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
  });
}
