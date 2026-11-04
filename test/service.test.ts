import { test } from "node:test";
import assert from "node:assert/strict";
import { CardService, type AgentCard } from "../src/adapters/virtualCards/CardService.js";
import type { FundingSource } from "../src/domain/interfaces/FundingSource.js";
import type { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";

const card: AgentCard = { id: "c1", agentId: "a1", policy: { perTransactionCents: 5_000, dailyCents: 8_000 } };
const funding: FundingSource = { fund: async () => ({ id: "r", status: "pending" }) };

function service(clock: { d: Date }) {
  return new CardService({} as MidenClient, funding, () => clock.d);
}

test("authorize accumulates daily spend and blocks over the limit", () => {
  const s = service({ d: new Date("2026-10-13T10:00:00Z") });
  assert.equal(s.authorize(card, 5_000).ok, true);
  assert.equal(s.authorize(card, 4_000).ok, false);
  assert.equal(s.authorize(card, 3_000).ok, true);
});

test("rejected attempts are not counted", () => {
  const s = service({ d: new Date("2026-10-13T10:00:00Z") });
  assert.equal(s.authorize(card, 6_000).ok, false);
  assert.equal(s.authorize(card, 5_000).ok, true);
  assert.equal(s.authorize(card, 3_000).ok, true);
});

test("daily total resets on a new UTC day", () => {
  const clock = { d: new Date("2026-10-13T23:59:00Z") };
  const s = service(clock);
  assert.equal(s.authorize(card, 5_000).ok, true);
  assert.equal(s.authorize(card, 5_000).ok, false);
  clock.d = new Date("2026-10-14T00:01:00Z");
  assert.equal(s.authorize(card, 5_000).ok, true);
});

import { CardService as IssueCardService } from "../src/adapters/virtualCards/CardService.js";
import { MidenClient as IssueMidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";

function issueFixture(reply: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (String(url).includes("/connect/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    return new Response(JSON.stringify(reply));
  }) as unknown as typeof fetch;
  const miden = new IssueMidenClient({ baseUrl: "https://x/miden", tokenUrl: "https://x/connect/token", clientId: "c", clientSecret: "s", uniqueKey: "u", fetch: f });
  return { svc: new IssueCardService(miden, { fund: async () => ({ id: "1", status: "confirmed" }) }), calls };
}

test("issue: posts v2 issue with KYC, limits and a stable Reference; returns the cardId", async () => {
  const policy = { perTransactionCents: 2500, dailyCents: 10000, allowedMccs: ["5734"] };
  const kyc = { customerId: "cust", kycToken: "tok" };
  const a = issueFixture({ isSuccessful: true, responseCode: "000", data: { cardId: "card-1", secureCardDetails: "SECRET" } });
  const card = await a.svc.issue("agent-1", policy, kyc, "ref-1");
  assert.equal(card.id, "card-1");
  assert.ok(!JSON.stringify(card).includes("SECRET"));
  const call = a.calls.find((c) => c.url.endsWith("/api/v2/cards/issue"))!;
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.customerId, "cust");
  assert.equal(body.clientReference, "ref-1");
  assert.deepEqual(body.cardLimits, { dailyLimit: "100.00", transactionLimit: "25.00" });
  assert.deepEqual(body.whiteListedMccs, ["5734"]);
  const b = issueFixture({ isSuccessful: true, responseCode: "000", data: { cardId: "card-1" } });
  await b.svc.issue("agent-1", policy, kyc, "ref-1");
  const refOf = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).Reference;
  assert.equal(refOf(call), refOf(b.calls.find((c) => c.url.endsWith("/api/v2/cards/issue"))!));
});

test("issue: 200 with a business failure is an error, not a card", async () => {
  const x = issueFixture({ isSuccessful: false, responseCode: "119", responseMessage: "nope" });
  await assert.rejects(x.svc.issue("a", { perTransactionCents: 1, dailyCents: 1 }, { customerId: "c", kycToken: "t" }, "r"), /119/);
});
