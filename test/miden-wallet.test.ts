import { test } from "node:test";
import assert from "node:assert/strict";
import { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { MidenWalletFunding, MidenDuplicateReferenceError, referenceFor } from "../src/adapters/funding/MidenWalletFunding.js";

interface Call { url: string; init: RequestInit & { headers: Record<string, string> } }

function setup(topup: () => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    calls.push({ url: u, init: init as Call["init"] });
    return topup();
  }) as typeof fetch;
  const miden = new MidenClient({
    baseUrl: "https://api.test/miden", tokenUrl: "https://id.test/connect/token",
    clientId: "id", clientSecret: "secret", uniqueKey: "uk", fetch: f,
  });
  return { funding: new MidenWalletFunding(miden), calls };
}

const req = { cardId: "card-1", amountCents: 1999, asset: "USDC" as const, idempotencyKey: "topup-42" };
const ok = () => Response.json({ cardTransactionId: 26191018, isSuccessful: true, responseCode: "000", responseMessage: "Card Top Up Successful" });

test("fund PATCHes /api/v1/cards/topup with dollars, USD wallet and the idempotency key", async () => {
  const { funding, calls } = setup(ok);
  const receipt = await funding.fund(req);
  assert.deepEqual(receipt, { id: "26191018", status: "confirmed" });
  const c = calls[0]!;
  assert.equal(c.url, "https://api.test/miden/api/v1/cards/topup");
  assert.equal(c.init.method, "PATCH");
  assert.deepEqual(JSON.parse(c.init.body as string), { cardId: "card-1", amount: 19.99, clientReference: "topup-42", walletCurrency: "USD" });
  assert.equal(c.init.headers.Reference, referenceFor("topup-42"));
  assert.equal(c.init.headers.Reference.length, 20);
});

test("retrying with the same key sends the same Reference", async () => {
  const { funding, calls } = setup(ok);
  await funding.fund(req);
  await funding.fund(req);
  assert.equal(calls[0]!.init.headers.Reference, calls[1]!.init.headers.Reference);
  await funding.fund({ ...req, idempotencyKey: "topup-43" });
  assert.notEqual(calls[0]!.init.headers.Reference, calls[2]!.init.headers.Reference);
});

test("HTTP 200 with isSuccessful=false is a failed receipt", async () => {
  const { funding } = setup(() => Response.json({ isSuccessful: false, responseCode: "119", responseMessage: "Insufficient funds" }));
  assert.deepEqual(await funding.fund(req), { id: "topup-42", status: "failed" });
});

test("'Reference already seen' 400 becomes MidenDuplicateReferenceError", async () => {
  const { funding } = setup(() => new Response("The Reference value has already been seen in the last 24 hours.", { status: 400 }));
  await assert.rejects(funding.fund(req), MidenDuplicateReferenceError);
});

test("other HTTP errors propagate as MidenApiError (caller may retry with the same key)", async () => {
  const { funding } = setup(() => new Response("boom", { status: 503 }));
  await assert.rejects(funding.fund(req), (e: Error) => e.name === "MidenApiError" && /503/.test(e.message));
});

test("rejects non-positive or fractional cents before calling Miden", async () => {
  const { funding, calls } = setup(ok);
  await assert.rejects(funding.fund({ ...req, amountCents: 0 }), RangeError);
  await assert.rejects(funding.fund({ ...req, amountCents: 10.5 }), RangeError);
  assert.equal(calls.length, 0);
});
