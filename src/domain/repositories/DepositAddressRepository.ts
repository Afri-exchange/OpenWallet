import type { DepositAddresses } from "../../adapters/deposits/BaseUsdcWatcher.js";

/** Deposit addresses we issued on one chain. One address funds exactly one card. */
export interface DepositAddressRepository extends DepositAddresses {
  /** Records an address for a card. Re-adding the same pair is a no-op; moving it to another card is refused. */
  add(address: string, cardId: string): Promise<void>;
  /** The card's first address issued from a derivation index (the one the dashboard shows), if any. */
  issuedAddressOf(cardId: string): Promise<string | undefined>;
  /** Draws the next unique derivation index (sequence deposit_derivation_seq). */
  nextDerivationIndex(): Promise<number>;
  /** Records an address for a card together with the derivation index it came from, atomically. */
  assign(address: string, cardId: string, derivationIndex: number): Promise<void>;
}
