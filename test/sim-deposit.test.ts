import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSimDeposit } from "../src/adapters/deposits/simDeposit.js";

const A = "0x" + "ab".repeat(20);

test("parses address, asset and dollars into cents", () => {
  assert.deepEqual(parseSimDeposit(`sim_${A}_usdc_25.5`), { address: A, asset: "USDC", amountCents: 2550, id: `sim_${A}_usdc_25.5` });
  assert.equal(parseSimDeposit(`sim_${A}_USDT_0.01_n1`)?.amountCents, 1);
});

test("rejects anything that is not the exact form", () => {
  for (const id of [
    `0x${"1".repeat(64)}`, "sim_", `sim_${A}`, `sim_${A}_USDC`, `sim_${A}_DAI_5`, `sim_0x12_USDC_5`,
    `sim_${A}_USDC_0`, `sim_${A}_USDC_-5`, `sim_${A}_USDC_1e3`, `sim_${A}_USDC_0.001`, `sim_${A}_USDC_5_a_b`, `sim_${A}_USDC_5_a-b`,
  ]) assert.equal(parseSimDeposit(id), null, id);
});
