import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { appUser } from "./cardholders.js";

// Developer layer (migration 010). Keys and sessions are stored only as SHA-256 hashes; the webhook secret must stay
// readable because we sign with it.

export const appDeveloper = pgTable("app_developer", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique("app_developer_email_key"),
  keyHash: text("key_hash").notNull().unique("app_developer_key_hash_key"),
  /** Default for new users: each payment is made with a fresh one-time card. */
  privacyMode: boolean("privacy_mode").notNull().default(false),
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** Short-lived tokens a developer hands to an end user's browser (hosted KYC and spend controls). */
export const appSession = pgTable(
  "app_session",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    developerId: text("developer_id").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("app_session_user").on(t.userId),
    foreignKey({ name: "app_session_user_id_fkey", columns: [t.userId], foreignColumns: [appUser.id] }),
    foreignKey({ name: "app_session_developer_id_fkey", columns: [t.developerId], foreignColumns: [appDeveloper.id] }),
  ],
);

export const WEBHOOK_STATUSES = ["pending", "delivered", "failed"] as const;

/** Webhook outbox: one row per event per developer, delivered with retries. */
export const appWebhookEvent = pgTable(
  "app_webhook_event",
  {
    id: text("id").primaryKey(),
    developerId: text("developer_id").notNull(),
    type: text("type").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: WEBHOOK_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    deliveredAt: timestamptz("delivered_at"),
  },
  (t) => [
    foreignKey({ name: "app_webhook_event_developer_id_fkey", columns: [t.developerId], foreignColumns: [appDeveloper.id] }),
    index("app_webhook_due").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    check("app_webhook_event_status_check", sql`${t.status} IN ('pending', 'delivered', 'failed')`),
  ],
);
