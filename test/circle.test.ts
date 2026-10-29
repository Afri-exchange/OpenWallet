import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, sign, constants } from "node:crypto";
import { CircleClient, CircleDeposits, usdcToBaseUnits, uuidFrom, type CircleTx } from "../src/chain/circle.js";
import { Ledger, accounts } from "../src/ledger/ledger.js";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = ec.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const signBody = (b: string) => sign("sha256", Buffer.from(b), ec.privateKey).toString("base64");

const ADDR = "0x" + "ab".repeat(20);
function setup(tx: Partial<CircleTx> = {}, symbol = "USDC") {
  const ledger = new Ledger();
  const full: CircleTx = { id: "t1", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, transactionType: "INBOUND", state: "COMPLETE", amounts: ["12.345678"], txHash: "0xAAA", ...tx };
  const circle = { notificationKey: async () => ({ algorithm: "ECDSA_SHA_256", publicKey: pub }), transaction: async () => full, tokenSymbol: async () => symbol };
  const dust: bigint[] = [];
  const d = new CircleDeposits({ circle, ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onDust: (x) => dust.push(x.dustBase) });
  const body = JSON.stringify({ notificationType: "transactions.inbound", notification: { id: "t1", amounts: ["999"] } });
  return { ledger, d, body, dust };
}
const hdr = (b: string) => ({ signature: signBody(b), keyId: "k1" });

test("a signed inbound USDC webhook credits the card once, from Circle's own amount", async () => {
  const s = setup();
  const r = await s.d.handle(s.body, hdr(s.body));
  assert.deepEqual(r, { status: "credited", cardId: "card1", amountCents: 1234, chain: "base-sepolia", isNew: true });
  assert.deepEqual(s.dust, [5678n]);
  const again = await s.d.handle(s.body, hdr(s.body)); // Circle delivers at least once
  assert.equal((again as { isNew: boolean }).isNew, false);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 1234);
});

test("bad or missing signatures are refused and credit nothing", async () => {
  const s = setup();
  await assert.rejects(s.d.handle(s.body, { signature: signBody(s.body + " "), keyId: "k1" }), /bad signature/);
  await assert.rejects(s.d.handle(s.body, {}), /missing signature/);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
});

test("ignored: not complete, not USDC, outbound, unknown address, unsupported chain", async () => {
  for (const [tx, sym, why] of [
    [{ state: "CONFIRMED" }, "USDC", /state/], [{}, "EURC", /not USDC/], [{ transactionType: "OUTBOUND" }, "USDC", /not inbound/],
    [{ destinationAddress: "0x" + "cd".repeat(20) }, "USDC", /not one of ours|not one of our/], [{ blockchain: "ETH" }, "USDC", /unsupported/],
  ] as const) {
    const s = setup(tx, sym);
    const r = await s.d.handle(s.body, hdr(s.body));
    assert.equal(r.status, "ignored");
    assert.match((r as { reason: string }).reason, why);
    assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
  }
});

test("reconcile credits a missed deposit once and is a no-op on the next pass", async () => {
  const s = setup();
  const credited: number[] = [];
  const full: CircleTx = { id: "t9", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, transactionType: "INBOUND", state: "COMPLETE", amounts: ["5"], txHash: "0xBBB" };
  const other: CircleTx = { ...full, id: "t8", txHash: "0xCCC", destinationAddress: "0x" + "cd".repeat(20) };
  const d = new CircleDeposits({
    circle: { notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async () => full, tokenSymbol: async () => "USDC", recentInbound: async () => [full, other] },
    ledger: s.ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onCredited: (r) => credited.push(r.amountCents),
  });
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 1 });
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 0 });
  assert.deepEqual(credited, [500]);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 500);
});

test("amount parsing is strict", () => {
  assert.equal(usdcToBaseUnits("1"), 1_000_000n);
  assert.equal(usdcToBaseUnits("0.01"), 10_000n);
  for (const bad of ["-1", "1e6", "1.1234567", "", "abc", "1,5"]) assert.equal(usdcToBaseUnits(bad), null);
});

test("wallet creation sends a decryptable entity secret and a stable idempotency key", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = "ab".repeat(32);
  const calls: { url: string; body?: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const data = url.endsWith("/publicKey") ? { publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }) } : { wallets: [{ id: "w1", address: ADDR.toUpperCase().replace("0X", "0x") }] };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: secret, walletSetId: "ws", fetch: f });
  assert.deepEqual(await c.createDepositWallet(7), { id: "w1", address: ADDR });
  await c.createDepositWallet(7);
  const posts = calls.filter((x) => x.body);
  assert.equal(posts[0]!.body.idempotencyKey, posts[1]!.body.idempotencyKey);
  assert.equal(posts[0]!.body.idempotencyKey, uuidFrom("agent-cards-deposit-wallet:ws:7"));
  assert.notEqual(posts[0]!.body.entitySecretCiphertext, posts[1]!.body.entitySecretCiphertext); // fresh per request
  const plain = privateDecrypt({ key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(posts[0]!.body.entitySecretCiphertext, "base64"));
  assert.equal(plain.toString("hex"), secret);
  assert.deepEqual(posts[0]!.body.blockchains, ["BASE-SEPOLIA"]);
});
