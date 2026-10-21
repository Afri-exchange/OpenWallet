import { test } from "node:test";
import assert from "node:assert/strict";
import { newReference, sign } from "../src/miden/signature.js";

const p = { method: "post", url: "https://x.test/a?b=c", reference: "ref", clientId: "id", clientSecret: "secret" };

test("reference is 20 chars", () => assert.equal(newReference().length, 20));
test("matches a vector computed independently with shasum | base64", () => {
  // printf '%s' 'POST&https%3A%2F%2Fx.test%2Fa%3Fb%3Dc&ref&id&secret' | shasum -a 1 | cut -d' ' -f1 | tr -d '\n' | base64
  assert.equal(sign(p), "Y2U1MGMwMzlkMWU2OGU3Nzk1M2ZkYmJmZDQ5MzgxNWZkZjI5NjJiYw==");
});
