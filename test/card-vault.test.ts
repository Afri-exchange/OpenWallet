import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import { CardService } from "../src/adapters/virtualCards/CardService.js";
import { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { decryptSecureCardDetails, parseExpiry } from "../src/lib/clients/cardIssuing/miden/cardDetails.js";
import { PgLedgerStore } from "../src/db/repositories/PgLedgerStore.js";
import { MemoryCardVault, PgCardVault, vaultKeyFromEnv, type CardDetails } from "../src/adapters/cardVault/CardVault.js";

// The sample on docs.miden.co/decrypt-encrypted-card-details-copy.md (public, not a real card).
const DOC_CLIENT_ID = "GEORGEDAUGHTERS4BF84D67844F4A3E94E884719E6DBDDF";
const DOC_CIPHERTEXT = "sxffEgIcRfEtc+ksicd/ednipGRhwtBZYOowlrFx9uWpJDq8Q0AYsswX2c9WCAunG5PSeYYEJwYD6h2Rbi0rp4KUvW3W5KqAJ9Obe9euN30=";

function midenEncrypt(json: object, material: string, order: "key=last" | "key=first"): string {
  const s = material.replace(/-/g, "");
  const [k, iv] = order === "key=last" ? [s.slice(-16), s.slice(0, 16)] : [s.slice(0, 16), s.slice(-16)];
  const c = createCipheriv("aes-128-cbc", Buffer.from(k), Buffer.from(iv));
  return Buffer.concat([c.update(JSON.stringify(json)), c.final()]).toString("base64");
}

test("decrypts the Miden docs sample vector (ClientId, key = last 16, IV = first 16)", () => {
  const { details, scheme } = decryptSecureCardDetails(DOC_CIPHERTEXT, { clientId: DOC_CLIENT_ID, uniqueKey: "" });
  assert.equal(scheme, "clientId:key=last16,iv=first16");
  assert.deepEqual(details, { pan: "5319935890865985", cvv: "011", expMonth: 3, expYear: 2028 });
});

test("decrypts a UniqueKey-keyed payload too, either order", () => {
  const uniqueKey = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f809a1b";
  const keys = { clientId: "SOMECLIENTIDTHATISLONGENOUGH0000", uniqueKey };
  for (const order of ["key=last", "key=first"] as const) {
    const ct = midenEncrypt({ CardNumber: "4111111111111111", SecurityCode: "123", Expiration: "12/31" }, uniqueKey, order);
    const r = decryptSecureCardDetails(ct, keys);
    assert.match(r.scheme, /^uniqueKey:/);
    assert.deepEqual(r.details, { pan: "4111111111111111", cvv: "123", expMonth: 12, expYear: 2031 });
  }
});

test("wrong keys fail without leaking anything", () => {
  assert.throws(
    () => decryptSecureCardDetails(DOC_CIPHERTEXT, { clientId: "X".repeat(32), uniqueKey: "Y".repeat(32) }),
    (e: Error) => /no key\/IV candidate/.test(e.message) && !e.message.includes("5319") && !e.message.includes("XXXX"),
  );
  assert.throws(() => decryptSecureCardDetails("bm90IGJsb2Nrcw==", { clientId: DOC_CLIENT_ID, uniqueKey: "" }), /AES blocks/);
});

test("expiry formats", () => {
  assert.deepEqual(parseExpiry("0328"), { expMonth: 3, expYear: 2028 });
  assert.deepEqual(parseExpiry("03/28"), { expMonth: 3, expYear: 2028 });
  assert.deepEqual(parseExpiry("03/2028"), { expMonth: 3, expYear: 2028 });
  assert.deepEqual(parseExpiry("2028-03-31T00:00:00"), { expMonth: 3, expYear: 2028 });
  assert.throws(() => parseExpiry("1328"));
});

const D: CardDetails = { pan: "4111111111111111", cvv: "123", expMonth: 12, expYear: 2031, nameOnCard: "Ada Obi" };

test("memory vault: put, has, audited reveal, purpose required", async () => {
  const v = new MemoryCardVault();
  assert.equal(await v.has("c1"), false);
  assert.equal(await v.reveal("c1", "checkout:x"), null);
  await v.put("c1", D);
  assert.equal(await v.has("c1"), true);
  assert.deepEqual(await v.reveal("c1", "checkout:1"), D);
  await assert.rejects(v.reveal("c1", " "), /purpose/);
  await assert.rejects(v.put("c2", { ...D, pan: "41x1" }), /pan/);
  assert.deepEqual(v.audit.map((a) => a.action), ["reveal_miss", "put", "reveal"]);
});

test("vaultKeyFromEnv: requires exactly 32 base64 bytes and never echoes the value", () => {
  assert.equal(vaultKeyFromEnv({ CARD_VAULT_KEY: randomBytes(32).toString("base64") }).length, 32);
  assert.throws(() => vaultKeyFromEnv({}), /Missing env var CARD_VAULT_KEY/);
  assert.throws(() => vaultKeyFromEnv({ CARD_VAULT_KEY: "c2hvcnQ=" }), (e: Error) => !e.message.includes("c2hvcnQ"));
});

// ---- issue-time capture ----

function midenFake(routes: Record<string, unknown>, clientId = "CLIENTID-ABCDEFGHIJKLMNOPQRSTUVWX", uniqueKey = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f809a1b") {
  const paths: string[] = [];
  const f = (async (url: string) => {
    if (String(url).includes("/connect/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    const path = new URL(url).pathname.replace(/^\/miden/, "");
    paths.push(path);
    const r = routes[path];
    return r === undefined ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(r));
  }) as unknown as typeof fetch;
  const miden = new MidenClient({ baseUrl: "https://x/miden", tokenUrl: "https://x/connect/token", clientId, clientSecret: "s", uniqueKey, fetch: f });
  return { miden, paths, keys: { clientId, uniqueKey } };
}

const policy = { perTransactionCents: 1000, dailyCents: 1000 };
const kyc = { customerId: "cust", kycToken: "tok" };
const funding = { fund: async () => ({ id: "1", status: "confirmed" as const }) };

test("issue captures secureCardDetails into the vault and returns no card data", async () => {
  const uk = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f809a1b";
  const secure = midenEncrypt({ CardNumber: "4111111111111111", SecurityCode: "123", Expiration: "0331" }, uk, "key=last");
  const m = midenFake({ "/api/v2/cards/issue": { isSuccessful: true, responseCode: "000", data: { cardId: "card-1", firstSix: "411111", lastFour: "1111", secureCardDetails: secure } } }, undefined, uk);
  const vault = new MemoryCardVault();
  const logs: string[] = [];
  const svc = new CardService(m.miden, funding, undefined, { vault, keys: m.keys, log: (s) => logs.push(s) });
  const card = await svc.issue("a", policy, kyc, "ref");
  assert.equal(card.detailsCaptured, true);
  assert.ok(!JSON.stringify(card).includes("4111111111111111"));
  assert.deepEqual(await vault.reveal("card-1", "test"), { pan: "4111111111111111", cvv: "123", expMonth: 3, expYear: 2031 });
  assert.ok(logs.every((l) => !l.includes("411111111111") && !l.includes("123,") && !l.includes(secure)));
  // full-PAN (404 here) is only for name/ZIP; the issue-time capture stands without it.
  assert.deepEqual(m.paths, ["/api/v2/cards/issue", "/api/v1/cards/details/card-1/full-pan"]);
});

test("issue adds name and billing ZIP from full-PAN when its PAN matches", async () => {
  const uk = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f809a1b";
  const secure = midenEncrypt({ CardNumber: "4111111111111111", SecurityCode: "123", Expiration: "0331" }, uk, "key=last");
  const fullPan = (pan: string) => ({ isSuccessful: true, responseCode: "000", data: { cardNumber: pan, securityCode: "123", expiration: "03/31", firstName: "Ada", lastName: "Obi", billingDetails: { zipCode: "10001" } } });
  const m = midenFake({
    "/api/v2/cards/issue": { isSuccessful: true, responseCode: "000", data: { cardId: "c5", lastFour: "1111", secureCardDetails: secure } },
    "/api/v1/cards/details/c5/full-pan": fullPan("4111111111111111"),
  }, undefined, uk);
  const vault = new MemoryCardVault();
  await new CardService(m.miden, funding, undefined, { vault, keys: m.keys }).issue("a", policy, kyc, "ref");
  assert.deepEqual(await vault.reveal("c5", "t"), { pan: "4111111111111111", cvv: "123", expMonth: 3, expYear: 2031, nameOnCard: "Ada Obi", billingZip: "10001" });

  // A full-PAN answer for some other card number never replaces the issue-time capture.
  const m2 = midenFake({
    "/api/v2/cards/issue": { isSuccessful: true, responseCode: "000", data: { cardId: "c6", lastFour: "1111", secureCardDetails: secure } },
    "/api/v1/cards/details/c6/full-pan": fullPan("4000000000000002"),
  }, undefined, uk);
  const v2 = new MemoryCardVault();
  await new CardService(m2.miden, funding, undefined, { vault: v2, keys: m2.keys }).issue("a", policy, kyc, "ref");
  assert.deepEqual(await v2.reveal("c6", "t"), { pan: "4111111111111111", cvv: "123", expMonth: 3, expYear: 2031 });
});

test("full-PAN billingDetails becomes a street billing address only when line1, city and country are set", async () => {
  const uk = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f809a1b";
  const secure = midenEncrypt({ CardNumber: "4111111111111111", SecurityCode: "123", Expiration: "0331" }, uk, "key=last");
  const run = async (billingDetails: Record<string, string>) => {
    const m = midenFake({
      "/api/v2/cards/issue": { isSuccessful: true, responseCode: "000", data: { cardId: "c7", lastFour: "1111", secureCardDetails: secure } },
      "/api/v1/cards/details/c7/full-pan": { isSuccessful: true, responseCode: "000", data: { cardNumber: "4111111111111111", securityCode: "123", expiration: "03/31", firstName: "Ada", lastName: "Obi", billingDetails } },
    }, undefined, uk);
    const vault = new MemoryCardVault();
    await new CardService(m.miden, funding, undefined, { vault, keys: m.keys }).issue("a", policy, kyc, "ref");
    return vault.reveal("c7", "t");
  };
  const full = { firstName: "Ada", lastName: "Obi", addressLine1: " 1 Marina Rd ", addressLine2: "", city: "Lagos", state: "Lagos", zipCode: "101241", country: "NG" };
  assert.deepEqual((await run(full))?.billingAddress, { line1: "1 Marina Rd", city: "Lagos", state: "Lagos", country: "NG" });
  assert.equal((await run(full))?.billingZip, "101241");
  const partial = await run({ ...full, addressLine1: "" });
  assert.equal(partial?.billingAddress, undefined);
  assert.equal(partial?.billingZip, "101241");
});

test("a decrypt that disagrees with the issued lastFour is rejected, then full-PAN is tried", async () => {
  const uk = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f809a1b";
  const secure = midenEncrypt({ CardNumber: "4111111111111111", SecurityCode: "123", Expiration: "0331" }, uk, "key=last");
  const m = midenFake({
    "/api/v2/cards/issue": { isSuccessful: true, responseCode: "000", data: { cardId: "card-2", lastFour: "9999", secureCardDetails: secure } },
    "/api/v1/cards/details/card-2/full-pan": {
      isSuccessful: true, responseCode: "000",
      data: { cardNumber: "4000000000009999", securityCode: "456", expiration: "07/30", firstName: "Ada", lastName: "Obi", billingDetails: { zipCode: "10001" } },
    },
  }, undefined, uk);
  const vault = new MemoryCardVault();
  const card = await new CardService(m.miden, funding, undefined, { vault, keys: m.keys }).issue("a", policy, kyc, "ref");
  assert.equal(card.detailsCaptured, true);
  assert.deepEqual(await vault.reveal("card-2", "t"), { pan: "4000000000009999", cvv: "456", expMonth: 7, expYear: 2030, nameOnCard: "Ada Obi", billingZip: "10001" });
  assert.deepEqual(vault.audit.find((a) => a.action === "put")?.purpose, "capture:full-pan");
});

test("capture failing everywhere still returns the issued card, flagged not captured", async () => {
  const m = midenFake({ "/api/v2/cards/issue": { isSuccessful: true, responseCode: "000", data: { cardId: "card-3" } } });
  const logs: string[] = [];
  const card = await new CardService(m.miden, funding, undefined, { vault: new MemoryCardVault(), keys: m.keys, log: (s) => logs.push(s) }).issue("a", policy, kyc, "ref");
  assert.equal(card.id, "card-3");
  assert.equal(card.detailsCaptured, false);
  assert.equal(logs.length, 2);
});

test("vault down at issue: card still returned, not captured", async () => {
  const uk = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f809a1b";
  const secure = midenEncrypt({ CardNumber: "4111111111111111", SecurityCode: "123", Expiration: "0331" }, uk, "key=last");
  const m = midenFake({ "/api/v2/cards/issue": { isSuccessful: true, responseCode: "000", data: { cardId: "card-4", secureCardDetails: secure } } }, undefined, uk);
  const broken = { put: async () => { throw new Error("db down"); }, has: async () => { throw new Error("db down"); } };
  const card = await new CardService(m.miden, funding, undefined, { vault: broken, keys: m.keys }).issue("a", policy, kyc, "ref");
  assert.equal(card.detailsCaptured, false);
});

// ---- Postgres vault (only with DATABASE_URL) ----

const databaseUrl = process.env.DATABASE_URL;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const pools: pg.Pool[] = [];
const schemas: string[] = [];
after(async () => {
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

test("pg vault: sealed at rest, audited, rows bound to their card", { skip: !databaseUrl }, async () => {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
  pools.push(pool);
  await new PgLedgerStore(pool).migrate();
  const key = randomBytes(32);
  const v = new PgCardVault(pool, key);
  await v.put("c1", D);
  await v.put("c2", { ...D, pan: "4000000000000002" });
  assert.equal(await v.has("c1"), true);
  const raw = (await pool.query("SELECT ciphertext, last4 FROM card_vault WHERE card_id = 'c1'")).rows[0];
  assert.ok(!Buffer.from(raw.ciphertext).toString("latin1").includes("4111"));
  assert.equal(raw.last4, "1111");
  assert.deepEqual(await v.reveal("c1", "checkout:abc"), D);
  assert.equal(await v.reveal("nope", "checkout:abc"), null);
  // Moving c2's sealed row onto c1 must not decrypt (AAD binds the card id).
  await pool.query("UPDATE card_vault SET iv = s.iv, ciphertext = s.ciphertext, tag = s.tag FROM card_vault s WHERE card_vault.card_id = 'c1' AND s.card_id = 'c2'");
  await assert.rejects(v.reveal("c1", "checkout:abc"));
  await assert.rejects(new PgCardVault(pool, randomBytes(32)).reveal("c2", "x"));
  const audit = (await pool.query("SELECT card_id, action, purpose FROM card_vault_audit ORDER BY id")).rows;
  assert.deepEqual(audit.map((a) => `${a.card_id}:${a.action}:${a.purpose}`), [
    "c1:put:capture:issue", "c2:put:capture:issue", "c1:reveal:checkout:abc", "nope:reveal_miss:checkout:abc", "c1:reveal:checkout:abc", "c2:reveal:x",
  ]);
});
