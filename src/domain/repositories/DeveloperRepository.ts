import type { Developer } from "../types/Entities.js";

/** app_developer: developer accounts, keys and webhook settings, plus the developer-scoped reads of their users and sessions. */
export interface DeveloperRepository {
  /** Inserts a developer. False if the email or key is already taken (a unique constraint). */
  create(developer: { id: string; name: string; email: string; keyHash: string }): Promise<boolean>;
  find(developerId: string): Promise<Developer | undefined>;
  idByKeyHash(keyHash: string): Promise<string | undefined>;
  setKeyHash(developerId: string, keyHash: string): Promise<void>;
  setPrivacyMode(developerId: string, privacyMode: boolean): Promise<void>;
  /** Sets (or, with nulls, removes) the webhook URL and its signing secret together. */
  setWebhook(developerId: string, url: string | null, secret: string | null): Promise<void>;
  /** How many end users the developer has. */
  countUsers(developerId: string): Promise<number>;
  /** The developer's user ids, newest first, optionally only the one with `externalId`. */
  listUserIds(developerId: string, limit: number, externalId?: string): Promise<string[]>;
  /** Deletes the developer's browser sessions, all of them or only one user's. Returns how many went. */
  deleteSessions(developerId: string, userId?: string): Promise<number>;
}
