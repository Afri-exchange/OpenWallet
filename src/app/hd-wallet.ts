import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { english, generateMnemonic, mnemonicToAccount, type HDAccount } from "viem/accounts";

/**
 * Our own deposit wallet: one BIP-39 mnemonic, one address per card at m/44'/60'/0'/0/<index>.
 * SANDBOX/TESTNET ONLY: the mnemonic sits in a local file (mode 600, git-ignored). Production needs real
 * custody (HSM/KMS or a custody provider) and a sweep to treasury; nothing here sweeps.
 */
export class HdDepositWallet {
  private constructor(private readonly mnemonic: string) {}

  /** Loads the mnemonic from `path`, creating it on first use. Refuses a file others can read. */
  static loadOrCreate(path: string): HdDepositWallet {
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify({ note: "TESTNET ONLY. Deposit wallet mnemonic for the agent-cards sandbox.", mnemonic: generateMnemonic(english) }) + "\n", { mode: 0o600 });
    }
    // Check before fixing: a file others could read may already have leaked, so the key must be replaced, not quietly re-protected.
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new Error(`${path} was readable by other users, so treat this mnemonic as exposed: move the file away (new deposit addresses follow) or, if you are sure it is safe, chmod 600 it`);
    }
    const { mnemonic } = JSON.parse(readFileSync(path, "utf8")) as { mnemonic?: string };
    if (!mnemonic || mnemonic.trim().split(/\s+/).length < 12) throw new Error(`${path} has no valid mnemonic`);
    return new HdDepositWallet(mnemonic.trim());
  }

  /**
   * The account merchant payouts are sent from: m/44'/60'/1'/0/0, a different BIP-44 account from every
   * deposit address (account 0), so USDC sent to it never credits a card. Fund it with test USDC and ETH.
   */
  payoutAccount(): HDAccount {
    return mnemonicToAccount(this.mnemonic, { accountIndex: 1, addressIndex: 0 });
  }

  address(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) throw new Error("bad derivation index");
    return mnemonicToAccount(this.mnemonic, { addressIndex: index }).address.toLowerCase();
  }
}
