import { and, eq, gt, isNotNull, isNull, lt, ne } from "drizzle-orm";
import type { UserRepository } from "../../domain/repositories/UserRepository.js";
import { isUniqueViolation, type Database } from "../client.js";
import { appCard, appDeveloper, appSession, appUser } from "../schema/index.js";

export const createUserRepository = (db: Database): UserRepository => ({
  async create(user) {
    try {
      await db.insert(appUser).values({
        id: user.id,
        email: user.email,
        tokenHash: user.tokenHash,
        ...(user.developerId !== undefined ? { developerId: user.developerId } : {}),
        ...(user.externalId !== undefined ? { externalId: user.externalId } : {}),
        ...(user.privacyMode !== undefined ? { privacyMode: user.privacyMode } : {}),
      });
      return "created";
    } catch (e) {
      if (isUniqueViolation(e)) return "duplicate";
      throw e;
    }
  },

  async findById(userId) {
    const [row] = await db.select().from(appUser).where(eq(appUser.id, userId));
    return row;
  },

  async findIdByTokenHash(tokenHash) {
    const [row] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.tokenHash, tokenHash));
    return row?.id;
  },

  async findIdByExternalId(developerId, externalId) {
    const [row] = await db
      .select({ id: appUser.id })
      .from(appUser)
      .where(and(eq(appUser.developerId, developerId), eq(appUser.externalId, externalId)));
    return row?.id;
  },

  async developerPrivacyDefault(developerId) {
    const [row] = await db.select({ privacyMode: appDeveloper.privacyMode }).from(appDeveloper).where(eq(appDeveloper.id, developerId));
    return row?.privacyMode === true;
  },

  async setTokenHash(userId, tokenHash) {
    await db.update(appUser).set({ tokenHash }).where(eq(appUser.id, userId));
  },

  async setKycSubmission(userId, reference, status) {
    await db.update(appUser).set({ kycReference: reference, kycStatus: status }).where(eq(appUser.id, userId));
  },

  async setKycStatus(userId, status) {
    await db.update(appUser).set({ kycStatus: status }).where(eq(appUser.id, userId));
  },

  async pendingKycUserIds() {
    const rows = await db
      .select({ id: appUser.id })
      .from(appUser)
      .leftJoin(appCard, eq(appCard.userId, appUser.id))
      .where(and(isNotNull(appUser.kycReference), isNull(appCard.cardId), ne(appUser.kycStatus, "Rejected")));
    return rows.map((r) => r.id);
  },

  async createSession(session) {
    await db.insert(appSession).values(session);
  },

  async deleteSessionsExpiredBefore(cutoff) {
    await db.delete(appSession).where(lt(appSession.expiresAt, cutoff));
  },

  async userIdBySession(tokenHash, now) {
    const [row] = await db
      .select({ userId: appSession.userId })
      .from(appSession)
      .where(and(eq(appSession.tokenHash, tokenHash), gt(appSession.expiresAt, now)));
    return row?.userId;
  },
});
