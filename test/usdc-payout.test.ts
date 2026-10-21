import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, keccak256, parseTransaction, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { BASE_SEPOLIA_USDC } from "../src/chain/base-usdc-watcher.js";
import { BASE_SEPOLIA_CHAIN_ID, UsdcPayoutRail } from "../src/chain/usdc-payout.js";

// Hardhat's well-known test mnemonic: never holds real funds.
const account = mnemonicToAccount("test test test test test test test test test test test junk", { accountIndex: 1 });
const TO = "0x1111111111111111111111111111111111111111";
const ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

function fakeRpc(over: Record<string, (params: unknown[]) => unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const base: Record<string, (params: unknown[]) => unknown> = {
    eth_getTransactionCount: () => "0x7",
    eth_estimateGas: () => "0xc350",
    eth_maxPriorityFeePerGas: () => "0x3e8",
    eth_getBlockByNumber: () => ({ baseFeePerGas: "0x10" }),
    eth_blockNumber: () => "0x64",
    eth_getTransactionReceipt: () => null,
    eth_sendRawTransaction: () => "0x",
    eth_call: () => `0x${(12_345_670_000n).toString(16)}`,
    ...over,
  };
  const rpc = async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    const f = base[method];
    if (!f) throw new Error(`unexpected ${method}`);
    return f(params);
  };
  return { rpc, calls };
}

test("usdc payout: signs a USDC transfer of exactly the amount, at the pending nonce, on Base Sepolia", async () => {
  const { rpc } = fakeRpc();
  const rail = new UsdcPayoutRail({ rpc, account });
  const t = await rail.sign({ to: TO, amountCents: 1_234 });
  assert.equal(t.nonce, 7);
  assert.equal(t.txHash, keccak256(t.rawTx as Hex));
  const tx = parseTransaction(t.rawTx as Hex);
  assert.equal(tx.chainId, BASE_SEPOLIA_CHAIN_ID);
  assert.equal(tx.to?.toLowerCase(), BASE_SEPOLIA_USDC);
  assert.equal(tx.value ?? 0n, 0n);
  assert.equal(tx.nonce, 7);
  const call = decodeFunctionData({ abi: ABI, data: tx.data! });
  assert.equal((call.args[0] as string).toLowerCase(), TO);
  assert.equal(call.args[1], 12_340_000n, "1234 cents = 12.34 USDC = 12,340,000 base units");
  assert.equal(await rail.balanceCents(), 1_234_567);
});

test("usdc payout: mainnet is refused until custody and a settlement hold exist", () => {
  const { rpc } = fakeRpc();
  assert.throws(() => new UsdcPayoutRail({ rpc, account, chainId: 8453 }), /testnet only/);
});

test("usdc payout: nothing is signed when the transfer would revert", async () => {
  const { rpc } = fakeRpc({ eth_estimateGas: () => { throw new Error("execution reverted: ERC20: transfer amount exceeds balance"); } });
  await assert.rejects(new UsdcPayoutRail({ rpc, account }).sign({ to: TO, amountCents: 1 }), /exceeds balance/);
  for (const to of ["0x12", "nope"]) await assert.rejects(new UsdcPayoutRail({ rpc, account }).sign({ to, amountCents: 1 }), /bad payout address/);
});

test("usdc payout: rebroadcasting the same bytes is not an error", async () => {
  for (const msg of ["already known", "nonce too low"]) {
    const { rpc } = fakeRpc({ eth_sendRawTransaction: () => { throw new Error(`RPC eth_sendRawTransaction error -32000: ${msg}`); } });
    await new UsdcPayoutRail({ rpc, account }).broadcast("0xabc");
  }
  const { rpc } = fakeRpc({ eth_sendRawTransaction: () => { throw new Error("insufficient funds for gas"); } });
  await assert.rejects(new UsdcPayoutRail({ rpc, account }).broadcast("0xabc"), /insufficient funds/);
});

test("usdc payout: state is confirmed or reverted only when deep enough; no receipt is pending, or replaced if the nonce moved on", async () => {
  const t = { txHash: "0xaa", nonce: 7 };
  const at = (receipt: unknown, head: string, mined = "0x7") =>
    new UsdcPayoutRail({ rpc: fakeRpc({ eth_getTransactionReceipt: () => receipt, eth_blockNumber: () => head, eth_getTransactionCount: () => mined }).rpc, account, confirmations: 5 }).state(t);
  assert.deepEqual(await at({ status: "0x1", blockNumber: "0x60" }, "0x64"), { state: "pending" }, "4 deep");
  assert.deepEqual(await at({ status: "0x1", blockNumber: "0x5f" }, "0x64"), { state: "confirmed" });
  assert.deepEqual(await at({ status: "0x0", blockNumber: "0x5f" }, "0x64"), { state: "reverted" });
  assert.deepEqual(await at(null, "0x64"), { state: "pending" });
  assert.deepEqual(await at(null, "0x64", "0x8"), { state: "replaced" });
});
