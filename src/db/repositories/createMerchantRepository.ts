import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { MerchantRepository } from "../../domain/repositories/MerchantRepository.js";
import { isUniqueViolation, type Database } from "../client.js";
import { appMerchant } from "../schema/index.js";

export const createMerchantRepository = (db: Database): MerchantRepository => ({
  async create(m) {
    try {
      await db.insert(appMerchant).values(m);
      return true;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  },

  async find(merchantId) {
    const [row] = await db.select().from(appMerchant).where(eq(appMerchant.merchantId, merchantId));
    return row;
  },

  async findIdByKeyHash(keyHash) {
    const [row] = await db.select({ merchantId: appMerchant.merchantId }).from(appMerchant).where(eq(appMerchant.keyHash, keyHash));
    return row?.merchantId;
  },

  async updateKeyHash(merchantId, keyHash) {
    await db.update(appMerchant).set({ keyHash }).where(eq(appMerchant.merchantId, merchantId));
  },

  async setPayoutAddress(merchantId, address, setAt) {
    // payout_address IS DISTINCT FROM address (address is never null), so re-setting the same address keeps its timer.
    await db
      .update(appMerchant)
      .set({ payoutAddress: address, payoutAddressSetAt: setAt })
      .where(and(eq(appMerchant.merchantId, merchantId), or(isNull(appMerchant.payoutAddress), ne(appMerchant.payoutAddress, address))));
  },
});

