import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/cards/policy.js";

const policy = { perTransactionCents: 5_000, dailyCents: 10_000, allowedMccs: ["5734"] };

test("allows within limits", () => {
  assert.deepEqual(evaluate(policy, { amountCents: 1_000, mcc: "5734", spentTodayCents: 0 }), { ok: true });
});
test("blocks over per-transaction limit", () => {
  assert.equal(evaluate(policy, { amountCents: 6_000, mcc: "5734", spentTodayCents: 0 }).ok, false);
});
test("blocks over daily limit", () => {
  assert.equal(evaluate(policy, { amountCents: 4_000, mcc: "5734", spentTodayCents: 7_000 }).ok, false);
});
test("blocks disallowed MCC", () => {
  assert.equal(evaluate(policy, { amountCents: 100, mcc: "7995", spentTodayCents: 0 }).ok, false);
});
