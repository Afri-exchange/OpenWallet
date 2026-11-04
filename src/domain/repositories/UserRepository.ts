import type { User } from "../types/Entities.js";

/** Whether an insert went in, or hit a unique constraint (email, token, or the developer's externalId). */
export type InsertOutcome = "created" | "duplicate";

/** app_user and app_session: cardholders, their tokens and short-lived sessions. */
export interface UserRepository {
  create(user: {
    id: string;
    email: string;
    tokenHash: string;
    developerId?: string;
    externalId?: string;
    privacyMode?: boolean;
  }): Promise<InsertOutcome>;
  findById(userId: string): Promise<User | undefined>;
  findIdByTokenHash(tokenHash: string): Promise<string | undefined>;
  findIdByExternalId(developerId: string, externalId: string): Promise<string | undefined>;
  /** The developer's default privacy mode for new users (false if the developer is unknown). */
  developerPrivacyDefault(developerId: string): Promise<boolean>;
  setTokenHash(userId: string, tokenHash: string): Promise<void>;
  setKycSubmission(userId: string, reference: string, status: string): Promise<void>;
  setKycStatus(userId: string, status: string): Promise<void>;
  /** Users with a KYC submission, no card yet, and not rejected (for the background poller). */
  pendingKycUserIds(): Promise<string[]>;

  createSession(session: { tokenHash: string; userId: string; developerId: string; expiresAt: Date }): Promise<void>;
  deleteSessionsExpiredBefore(cutoff: Date): Promise<void>;
  /** The user of a session that is still valid at `now`. */
  userIdBySession(tokenHash: string, now: Date): Promise<string | undefined>;
}
