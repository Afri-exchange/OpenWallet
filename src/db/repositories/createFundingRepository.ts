import type { FundingRepository } from "../../domain/repositories/FundingRepository.js";
import type { Database } from "../client.js";

export const createFundingRepository = (_db: Database): FundingRepository => ({});
