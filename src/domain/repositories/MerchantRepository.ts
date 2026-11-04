import type { Merchant } from "../types/Entities.js";

/** app_merchant: merchants, their keys and payout addresses. */
export interface MerchantRepository {
  /** Inserts a merchant. False if a unique column (email, key hash) is already taken. */
  create(m: { merchantId: string; name: string; email: string; mcc: string | null; keyHash: string }): Promise<boolean>;
  find(merchantId: string): Promise<Merchant | undefined>;
  /** The merchant whose secret key hashes to `keyHash`. */
  findIdByKeyHash(keyHash: string): Promise<string | undefined>;
  updateKeyHash(merchantId: string, keyHash: string): Promise<void>;
  /** Sets the payout address and when it was set, only if it differs from the current one (so the delay is not restarted). */
  setPayoutAddress(merchantId: string, address: string, setAt: Date): Promise<void>;
}
