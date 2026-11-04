import type { CardRepository } from "../../domain/repositories/CardRepository.js";
import type { Database } from "../client.js";

export const createCardRepository = (_db: Database): CardRepository => ({});
