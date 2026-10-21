import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HdDepositWallet } from "../src/app/hd-wallet.js";

test("creates a 600 wallet file and derives stable addresses", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hdw-")), "w.json");
  const w = HdDepositWallet.loadOrCreate(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(HdDepositWallet.loadOrCreate(path).address(3), w.address(3));
  assert.notEqual(w.address(0), w.address(1));
});

test("a wallet file others could read is refused, not silently re-protected", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hdw-")), "w.json");
  HdDepositWallet.loadOrCreate(path);
  chmodSync(path, 0o644);
  assert.throws(() => HdDepositWallet.loadOrCreate(path), /treat this mnemonic as exposed/);
  assert.equal(statSync(path).mode & 0o777, 0o644);
});
