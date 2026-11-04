import { test } from "node:test";
import assert from "node:assert/strict";
import { DeveloperInteractor } from "../../src/lib/interactors/DeveloperInteractor.ts";
import { verify } from "./webhook-verify.ts";

const secret = "whsec_test";
const body = JSON.stringify({ id: "evt_1", type: "spend.settled", data: { amountCents: 750 } });
const now = 1_800_000_000_000;
const header = (t: number, b = body, s = secret) => DeveloperInteractor.sign(s, t, b);

test("accepts what the service signs", () => assert.equal(verify(secret, header(now / 1000), body, now), true));
test("rejects a tampered body", () => assert.equal(verify(secret, header(now / 1000), body.replace("750", "75"), now), false));
test("rejects the wrong secret", () => assert.equal(verify(secret, header(now / 1000, body, "whsec_other"), body, now), false));
test("rejects a replay older than five minutes, and one from the future", () => {
  assert.equal(verify(secret, header(now / 1000 - 301), body, now), false);
  assert.equal(verify(secret, header(now / 1000 + 301), body, now), false);
  assert.equal(verify(secret, header(now / 1000 - 299), body, now), true);
});
test("rejects missing, empty and malformed headers without throwing", () => {
  for (const h of [undefined, "", "garbage", "t=abc,v1=00", `t=${now / 1000}`, `t=${now / 1000},v1=${"z".repeat(64)}`, `t=${now / 1000},v1=${"0".repeat(63)}`]) {
    assert.equal(verify(secret, h, body, now), false, String(h));
  }
});
test("a header with a trailing comma or extra fields still verifies on the real v1", () => {
  assert.equal(verify(secret, header(now / 1000) + ",v0=old", body, now), true);
});
