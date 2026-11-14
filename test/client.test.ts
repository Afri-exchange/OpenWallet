import { test } from "node:test";
import assert from "node:assert/strict";
import { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { sign } from "../src/lib/clients/cardIssuing/miden/signature.js";

const cfg = { baseUrl: "https://api.test/miden", tokenUrl: "https://id.test/connect/token", clientId: "id", clientSecret: "secret", uniqueKey: "uk" };

test("signs the full URL, query included, and sends the bearer token", async () => {
  let headers: Record<string, string> = {};
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer", scope: "CardAPIs" });
    headers = init.headers as Record<string, string>;
    return Response.json({ isSuccessful: true, responseCode: "000" });
  }) as typeof globalThis.fetch;
  await new MidenClient({ ...cfg, fetch }).request("GET", "/api/v1/wallet/balances?walletCurrency=USD");
  assert.equal(headers.Authorization, "Bearer tok");
  const url = "https://api.test/miden/api/v1/wallet/balances?walletCurrency=USD";
  assert.equal(headers.Signature, sign({ method: "GET", url, reference: headers.Reference ?? "", clientId: "id", clientSecret: "secret" }));
});

test("rejects a token response without access_token or expires_in", async () => {
  const fetch = (async () => Response.json({ token_type: "Bearer" })) as unknown as typeof globalThis.fetch;
  await assert.rejects(new MidenClient({ ...cfg, fetch }).request("GET", "/x"), /missing access_token or expires_in/);
});
