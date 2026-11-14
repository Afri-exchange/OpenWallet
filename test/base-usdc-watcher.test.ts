import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, accounts } from "../src/lib/services/Ledger.js";
import { BASE_USDC, BaseUsdcWatcher, MemoryCursor, TRANSFER_TOPIC, jsonRpc, type Dust, type RpcLog } from "../src/adapters/deposits/BaseUsdcWatcher.js";

const ADDR_A = "0x00000000000000000000000000000000000000aA";
const ADDR_B = "0x00000000000000000000000000000000000000bb";
const STRANGER = "0x00000000000000000000000000000000000000cc";
const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const amount = (base: bigint) => `0x${base.toString(16).padStart(64, "0")}`;

function transfer(to: string, base: bigint, block: number, tx: string, logIndex = 0, extra: Partial<RpcLog> = {}): RpcLog {
  return {
    address: BASE_USDC, topics: [TRANSFER_TOPIC, topic(STRANGER), topic(to)], data: amount(base),
    blockNumber: `0x${block.toString(16)}`, transactionHash: tx, logIndex: `0x${logIndex.toString(16)}`, ...extra,
  };
}

/** A fake chain: logs live at blocks; eth_getLogs applies the range and `to` filter like a node would. */
function chain(head: number, logs: RpcLog[]) {
  const calls: { method: string; params: unknown[] }[] = [];
  const state = { head, logs, failGetLogs: 0 };
  const rpc = async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === "eth_blockNumber") return `0x${state.head.toString(16)}`;
    if (method === "eth_getLogs") {
      if (state.failGetLogs > 0) { state.failGetLogs--; throw new Error("provider 503"); }
      const f = params[0] as { fromBlock: string; toBlock: string; topics: [string, null, string[]] };
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      return state.logs.filter((l) => {
        const b = parseInt(l.blockNumber, 16);
        return b >= from && b <= to && f.topics[2].includes(l.topics[2]!.toLowerCase());
      });
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls, state };
}

const cards = new Map([[ADDR_A.toLowerCase(), "card-a"], [ADDR_B.toLowerCase(), "card-b"]]);
const addresses = { all: async () => [...cards.keys()], cardFor: async (a: string) => cards.get(a.toLowerCase()) };

function setup(head: number, logs: RpcLog[], opts: { start?: number; cursor?: number; confirmations?: number; maxRange?: number; maxAddresses?: number } = {}) {
  const c = chain(head, logs);
  const ledger = new Ledger();
  const cursor = new MemoryCursor(opts.cursor);
  const dust: Dust[] = [];
  const w = new BaseUsdcWatcher({
    rpc: c.rpc, ledger, addresses, cursor, startBlock: opts.start ?? 100, confirmations: opts.confirmations ?? 10,
    maxRange: opts.maxRange, maxAddresses: opts.maxAddresses, onDust: (d) => { dust.push(d); },
  });
  return { ...c, ledger, cursor, w, dust };
}

const holding = (l: Ledger, card: string) => l.balance(accounts.holding(card));

test("credits confirmed transfers to the right card and advances the cursor", async () => {
  const s = setup(200, [transfer(ADDR_A, 25_000_000n, 150, "0xT1"), transfer(ADDR_B, 1_500_000n, 160, "0xT2", 3)]);
  const r = await s.w.tick();
  assert.deepEqual(r, { from: 100, to: 190, credited: 2, skipped: 0 });
  assert.equal(await holding(s.ledger, "card-a"), 2_500);
  assert.equal(await holding(s.ledger, "card-b"), 150);
  assert.equal(await s.cursor.get(), 190);
});

test("does not credit blocks inside the confirmation window", async () => {
  const s = setup(200, [transfer(ADDR_A, 1_000_000n, 195, "0xT1")]);
  await s.w.tick();
  assert.equal(await holding(s.ledger, "card-a"), 0);
  s.state.head = 205;
  await s.w.tick();
  assert.equal(await holding(s.ledger, "card-a"), 100);
});

test("returns undefined when caught up and leaves the cursor alone", async () => {
  const s = setup(200, [], { cursor: 190 });
  assert.equal(await s.w.tick(), undefined);
  assert.equal(await s.cursor.get(), 190);
});

test("refuses to start with no cursor and no startBlock", async () => {
  const c = chain(200, []);
  const w = new BaseUsdcWatcher({ rpc: c.rpc, ledger: new Ledger(), addresses, cursor: new MemoryCursor() });
  await assert.rejects(w.tick(), /no startBlock/);
});

test("a failed range leaves the cursor; the retry credits once", async () => {
  const s = setup(200, [transfer(ADDR_A, 1_000_000n, 150, "0xT1")]);
  s.state.failGetLogs = 1;
  await assert.rejects(s.w.tick(), /503/);
  assert.equal(await s.cursor.get(), undefined);
  await s.w.tick();
  assert.equal(await holding(s.ledger, "card-a"), 100);
});

test("replaying a range (crash before cursor save, or rescan) never double-credits", async () => {
  const s = setup(200, [transfer(ADDR_A, 1_000_000n, 150, "0xT1")]);
  await s.w.tick();
  await s.cursor.set(99);
  await s.w.tick();
  await s.w.rescan(100, 190);
  assert.equal(await holding(s.ledger, "card-a"), 100);
});

test("same tx hash, different log index, are two deposits; hash case is ignored", async () => {
  const s = setup(200, [transfer(ADDR_A, 1_000_000n, 150, "0xABC", 0), transfer(ADDR_A, 1_000_000n, 150, "0xabc", 1)]);
  await s.w.tick();
  await s.w.rescan(150, 150);
  assert.equal(await holding(s.ledger, "card-a"), 200);
});

test("floors to cents, reports dust, and credits nothing for sub-cent transfers", async () => {
  const s = setup(200, [transfer(ADDR_A, 1_005_000n, 150, "0xT1"), transfer(ADDR_A, 9_999n, 151, "0xT2")]);
  const r = await s.w.tick();
  assert.equal(await holding(s.ledger, "card-a"), 100);
  assert.deepEqual(r && [r.credited, r.skipped], [1, 1]);
  assert.deepEqual(s.dust.map((d) => [d.txHash, d.dustBase]), [["0xT1", 5_000n], ["0xT2", 9_999n]]);
});

test("ignores what a provider should have filtered: other tokens, removed logs, strangers, zero value", async () => {
  const s = setup(200, [
    transfer(ADDR_A, 1_000_000n, 150, "0xT1", 0, { address: "0x0000000000000000000000000000000000000bad" }),
    transfer(ADDR_A, 1_000_000n, 151, "0xT2", 0, { removed: true }),
    transfer(ADDR_A, 0n, 152, "0xT3"),
    transfer(ADDR_A, 1_000_000n, 153, "0xT4", 0, { topics: ["0xdead", topic(STRANGER), topic(ADDR_A)] }),
  ]);
  // A sloppy provider that returns everything regardless of filter.
  const sloppy = async (m: string, p: unknown[]) => (m === "eth_getLogs" ? [...s.state.logs, transfer(STRANGER, 5_000_000n, 154, "0xT5")] : s.rpc(m, p));
  const w = new BaseUsdcWatcher({ rpc: sloppy, ledger: s.ledger, addresses, cursor: s.cursor, startBlock: 100 });
  const r = await w.tick();
  assert.deepEqual(r && [r.credited, r.skipped], [0, 5]);
  assert.equal(await holding(s.ledger, "card-a"), 0);
});

test("a log outside the requested range is an error, not a credit", async () => {
  const s = setup(200, []);
  const liar = async (m: string, p: unknown[]) => (m === "eth_getLogs" ? [transfer(ADDR_A, 1_000_000n, 500, "0xT1")] : s.rpc(m, p));
  const w = new BaseUsdcWatcher({ rpc: liar, ledger: s.ledger, addresses, cursor: s.cursor, startBlock: 100 });
  await assert.rejects(w.tick(), /outside/);
  assert.equal(await s.cursor.get(), undefined);
});

test("splits work by maxRange and maxAddresses", async () => {
  const s = setup(1000, [transfer(ADDR_B, 1_000_000n, 120, "0xT1")], { maxRange: 50, maxAddresses: 1 });
  assert.deepEqual(await s.w.tick(), { from: 100, to: 149, credited: 1, skipped: 0 });
  const logCalls = s.calls.filter((c) => c.method === "eth_getLogs");
  assert.equal(logCalls.length, 2);
  for (const c of logCalls) assert.equal((c.params[0] as { topics: [string, null, string[]] }).topics[2].length, 1);
});

test("rescan refuses unconfirmed blocks", async () => {
  const s = setup(200, []);
  await assert.rejects(s.w.rescan(100, 195), /unconfirmed/);
});

test("run() catches up, then stops on abort", async () => {
  const s = setup(300, [transfer(ADDR_A, 1_000_000n, 250, "0xT1")], { maxRange: 50 });
  const ac = new AbortController();
  const errors: unknown[] = [];
  const done = s.w.run(ac.signal, { intervalMs: 5, onError: (e) => errors.push(e) });
  while ((await s.cursor.get()) !== 290) await new Promise((r) => setTimeout(r, 1));
  ac.abort();
  await done;
  assert.equal(await holding(s.ledger, "card-a"), 100);
  assert.deepEqual(errors, []);
});

test("jsonRpc surfaces RPC errors and HTTP failures", async () => {
  const ok = jsonRpc("http://x", (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }))) as typeof fetch);
  assert.equal(await ok("eth_blockNumber", []), "0x10");
  const err = jsonRpc("http://x", (async () => new Response(JSON.stringify({ error: { code: -32005, message: "range too large" } }))) as typeof fetch);
  await assert.rejects(err("eth_getLogs", []), /-32005: range too large/);
  const http = jsonRpc("http://x", (async () => new Response("nope", { status: 429 })) as typeof fetch);
  await assert.rejects(http("eth_blockNumber", []), /HTTP 429/);
});

test("finality 'finalized' credits only up to the finalized block, ignoring the head", async () => {
  const c = chain(200, [transfer(ADDR_A, 1_000_000n, 150, "0xF1"), transfer(ADDR_A, 2_000_000n, 170, "0xF2")]);
  const finalized = { number: "0xa0" }; // 160
  const rpc = async (method: string, params: unknown[]) =>
    method === "eth_getBlockByNumber" && params[0] === "finalized" ? finalized : c.rpc(method, params);
  const ledger = new Ledger();
  const w = new BaseUsdcWatcher({ rpc, ledger, addresses, cursor: new MemoryCursor(), startBlock: 100, finality: "finalized" });
  assert.deepEqual(await w.tick(), { from: 100, to: 160, credited: 1, skipped: 0 });
  assert.equal(await holding(ledger, "card-a"), 100);
  await assert.rejects(w.rescan(100, 170), /unconfirmed/);
});

test("finality 'finalized' refuses a missing finalized block rather than guessing", async () => {
  const c = chain(200, []);
  const rpc = async (method: string, params: unknown[]) => (method === "eth_getBlockByNumber" ? null : c.rpc(method, params));
  const w = new BaseUsdcWatcher({ rpc, ledger: new Ledger(), addresses, cursor: new MemoryCursor(), startBlock: 100, finality: "finalized" });
  await assert.rejects(w.tick(), /finalized block number/);
});
