import { test } from "node:test";
import assert from "node:assert/strict";
import { CardService, type AgentCard } from "../src/cards/service.js";
import type { FundingSource } from "../src/funding/types.js";
import type { MidenClient } from "../src/miden/client.js";

// Tests prefixed "BUG:" assert the desired behaviour and currently FAIL.

const funding: FundingSource = { fund: async () => ({ id: "r", status: "pending" }) };
const card = (over: Partial<AgentCard["policy"]> = {}, id = "c1"): AgentCard => ({ id, agentId: "a", policy: { perTransactionCents: 5_000, dailyCents: 8_000, ...over } });
const svc = (clock: { d: Date }) => new CardService({} as MidenClient, funding, () => clock.d);
const at = (iso: string) => ({ d: new Date(iso) });

// ---- invalid amounts ----

for (const [name, v] of [["NaN", NaN], ["negative", -100], ["zero", 0], ["fractional", 10.5], ["Infinity", Infinity], ["unsafe", Number.MAX_SAFE_INTEGER + 2]] as const) {
  test(`BUG: authorize rejects ${name} amount`, () => {
    const s = svc(at("2026-10-13T10:00:00Z"));
    assert.equal(s.authorize(card(), v).ok, false);
  });
}

test("BUG: a negative 'spend' must not reduce today's total and buy headroom", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  assert.equal(s.authorize(card(), 5_000).ok, true);
  s.authorize(card(), -5_000);
  assert.equal(s.authorize(card(), 5_000).ok, false, "5k already spent; the negative must not have bought headroom under the 8k daily cap");
});

test("BUG: NaN amount must not poison the day's counter", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  s.authorize(card(), NaN);
  // if NaN was stored as spent-today, every later comparison is false and the daily cap never trips
  assert.equal(s.authorize(card(), 5_000).ok, true);
  assert.equal(s.authorize(card(), 5_000).ok, false, "daily cap of 8k must still apply");
});

// ---- exact boundaries ----

test("amount exactly at per-tx limit passes, one cent over fails", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  assert.equal(s.authorize(card(), 5_001).ok, false);
  assert.equal(s.authorize(card(), 5_000).ok, true);
});

test("hitting the daily limit exactly passes, next cent fails", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  assert.equal(s.authorize(card(), 5_000).ok, true);
  assert.equal(s.authorize(card(), 3_000).ok, true);
  assert.equal(s.authorize(card(), 1).ok, false);
});

// ---- daily reset ----

test("reset happens exactly at 00:00:00.000 UTC, not a ms before", () => {
  const clock = at("2026-10-13T23:59:59.999Z");
  const s = svc(clock);
  assert.equal(s.authorize(card(), 5_000).ok, true);
  assert.equal(s.authorize(card(), 5_000).ok, false);
  clock.d = new Date("2026-10-14T00:00:00.000Z");
  assert.equal(s.authorize(card(), 5_000).ok, true);
});

test("reset is on the UTC day, not the server's local day", () => {
  // 23:30 at UTC-5 is 04:30 next UTC day: must be a new day
  const clock = at("2026-10-13T22:00:00-05:00"); // 03:00Z on the 14th
  const s = svc(clock);
  assert.equal(s.authorize(card(), 5_000).ok, true);
  clock.d = new Date("2026-10-14T02:59:00Z"); // still the 14th UTC
  assert.equal(s.authorize(card(), 3_000).ok, true);
  assert.equal(s.authorize(card(), 1).ok, false);
});

test("a rejected attempt on a new day does not carry or clobber anything", () => {
  const clock = at("2026-10-13T12:00:00Z");
  const s = svc(clock);
  s.authorize(card(), 5_000);
  clock.d = new Date("2026-10-14T12:00:00Z");
  assert.equal(s.authorize(card(), 9_999).ok, false);
  assert.equal(s.authorize(card(), 5_000).ok, true);
  assert.equal(s.authorize(card(), 3_000).ok, true);
});

test("skipping several days still resets", () => {
  const clock = at("2026-10-13T12:00:00Z");
  const s = svc(clock);
  s.authorize(card(), 5_000);
  s.authorize(card(), 3_000);
  clock.d = new Date("2026-11-20T00:00:00Z");
  assert.equal(s.authorize(card(), 5_000).ok, true);
});

test("BUG: clock stepping back across midnight must not hand out a fresh daily allowance for the earlier day", () => {
  const clock = at("2026-10-13T23:59:00Z");
  const s = svc(clock);
  assert.equal(s.authorize(card(), 5_000).ok, true);
  assert.equal(s.authorize(card(), 3_000).ok, true); // day 13 is now full
  clock.d = new Date("2026-10-14T00:00:30Z");
  assert.equal(s.authorize(card(), 1_000).ok, true); // overwrites the day-13 entry
  clock.d = new Date("2026-10-13T23:59:30Z"); // NTP step back / skewed second instance
  assert.equal(s.authorize(card(), 5_000).ok, false, "day 13 already spent its 8k");
});

test("an invalid clock throws rather than silently approving", () => {
  const s = svc({ d: new Date("nope") });
  assert.throws(() => s.authorize(card(), 100));
});

// ---- isolation / policy shape ----

test("daily totals are per card", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  assert.equal(s.authorize(card({}, "c1"), 5_000).ok, true);
  assert.equal(s.authorize(card({}, "c1"), 3_000).ok, true);
  assert.equal(s.authorize(card({}, "c2"), 5_000).ok, true);
});

test("the policy on the card passed in is used each call (a lowered limit applies immediately)", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  s.authorize(card(), 5_000);
  assert.equal(s.authorize(card({ dailyCents: 5_000 }), 1).ok, false);
});

test("empty allowedMccs blocks everything; missing mcc is blocked when a list exists", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  assert.equal(s.authorize(card({ allowedMccs: [] }), 100, "5411").ok, false);
  assert.equal(s.authorize(card({ allowedMccs: ["5411"] }), 100).ok, false);
  assert.equal(s.authorize(card({ allowedMccs: ["5411"] }), 100, "5411").ok, true);
});

test("a spend rejected for MCC is not counted toward the daily total", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  assert.equal(s.authorize(card({ allowedMccs: ["5411"] }), 5_000, "7995").ok, false);
  assert.equal(s.authorize(card({ allowedMccs: ["5411"] }), 5_000, "5411").ok, true);
  assert.equal(s.authorize(card({ allowedMccs: ["5411"] }), 3_000, "5411").ok, true);
});

test("many sequential attempts never exceed the daily cap", () => {
  const s = svc(at("2026-10-13T10:00:00Z"));
  let approved = 0;
  for (let i = 0; i < 1_000; i++) if (s.authorize(card(), 1_234).ok) approved += 1_234;
  assert.ok(approved <= 8_000, `approved ${approved}`);
});
