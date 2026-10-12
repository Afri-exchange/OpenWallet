import { test } from "node:test";
import assert from "node:assert/strict";
import { newReference, sign } from "../src/miden/signature.js";

const p = { method: "post", url: "https://x.test/a?b=c", reference: "ref", clientId: "id", clientSecret: "secret" };

test("reference is 20 chars", () => assert.equal(newReference().length, 20));
test("modes differ and are deterministic", () => {
  assert.notEqual(sign(p, "base64-of-hex"), sign(p, "base64-of-digest"));
  assert.equal(sign(p), sign(p));
});
