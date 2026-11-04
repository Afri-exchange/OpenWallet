import { and, count, desc, eq } from "drizzle-orm";
import type { DeveloperRepository } from "../../domain/repositories/DeveloperRepository.js";
import { isUniqueViolation, type Database } from "../client.js";
import { appDeveloper, appSession, appUser } from "../schema/index.js";

export const createDeveloperRepository = (db: Database): DeveloperRepository => ({
  async create(developer) {
    try {
      await db.insert(appDeveloper).values(developer);
      return true;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  },

  async find(developerId) {
    const [row] = await db.select().from(appDeveloper).where(eq(appDeveloper.id, developerId));
    return row;
  },

  async idByKeyHash(keyHash) {
    const [row] = await db.select({ id: appDeveloper.id }).from(appDeveloper).where(eq(appDeveloper.keyHash, keyHash));
    return row?.id;
  },

  async setKeyHash(developerId, keyHash) {
    await db.update(appDeveloper).set({ keyHash }).where(eq(appDeveloper.id, developerId));
  },

  async setPrivacyMode(developerId, privacyMode) {
    await db.update(appDeveloper).set({ privacyMode }).where(eq(appDeveloper.id, developerId));
  },

  async setWebhook(developerId, url, secret) {
    await db.update(appDeveloper).set({ webhookUrl: url, webhookSecret: secret }).where(eq(appDeveloper.id, developerId));
  },

  async countUsers(developerId) {
    const [row] = await db.select({ n: count() }).from(appUser).where(eq(appUser.developerId, developerId));
    return row?.n ?? 0;
  },

  async listUserIds(developerId, limit, externalId) {
    const rows = await db
      .select({ id: appUser.id })
      .from(appUser)
      .where(and(eq(appUser.developerId, developerId), externalId === undefined ? undefined : eq(appUser.externalId, externalId)))
      .orderBy(desc(appUser.createdAt))
      .limit(limit);
    return rows.map((r) => r.id);
  },

  async deleteSessions(developerId, userId) {
    const deleted = await db
      .delete(appSession)
      .where(and(eq(appSession.developerId, developerId), userId === undefined ? undefined : eq(appSession.userId, userId)))
      .returning({ tokenHash: appSession.tokenHash });
    return deleted.length;
  },
});
