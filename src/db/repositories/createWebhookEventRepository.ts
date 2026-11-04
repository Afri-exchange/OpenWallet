import type { WebhookEventRepository } from "../../domain/repositories/WebhookEventRepository.js";
import type { Database } from "../client.js";

export const createWebhookEventRepository = (_db: Database): WebhookEventRepository => ({});
