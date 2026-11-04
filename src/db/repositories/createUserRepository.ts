import type { UserRepository } from "../../domain/repositories/UserRepository.js";
import type { Database } from "../client.js";

export const createUserRepository = (_db: Database): UserRepository => ({});
