import type { Database } from "../client.js";
import type { CardVaultRepository } from "../../domain/repositories/CardVaultRepository.js";
import type { LedgerRepository } from "../../domain/repositories/LedgerStore.js";
import type { PayoutRepository } from "../../domain/repositories/PayoutRepository.js";
import { createCardVaultRepository } from "./createCardVaultRepository.js";
import { createLedgerStore } from "./createLedgerStore.js";
import { createPayoutRepository } from "./createPayoutRepository.js";
import { createUserRepository } from "./createUserRepository.js";
import type { UserRepository } from "../../domain/repositories/UserRepository.js";
import { createCardRepository } from "./createCardRepository.js";
import type { CardRepository } from "../../domain/repositories/CardRepository.js";
import { createAgentRepository } from "./createAgentRepository.js";
import type { AgentRepository } from "../../domain/repositories/AgentRepository.js";
import { createSpendRepository } from "./createSpendRepository.js";
import type { SpendRepository } from "../../domain/repositories/SpendRepository.js";
import { createFundingRepository } from "./createFundingRepository.js";
import type { FundingRepository } from "../../domain/repositories/FundingRepository.js";
import { createOneTimeCardRepository } from "./createOneTimeCardRepository.js";
import type { OneTimeCardRepository } from "../../domain/repositories/OneTimeCardRepository.js";
import { createDeveloperRepository } from "./createDeveloperRepository.js";
import type { DeveloperRepository } from "../../domain/repositories/DeveloperRepository.js";
import { createWebhookEventRepository } from "./createWebhookEventRepository.js";
import type { WebhookEventRepository } from "../../domain/repositories/WebhookEventRepository.js";
import { createMerchantRepository } from "./createMerchantRepository.js";
import type { MerchantRepository } from "../../domain/repositories/MerchantRepository.js";
import { createCheckoutRepository } from "./createCheckoutRepository.js";
import type { CheckoutRepository } from "../../domain/repositories/CheckoutRepository.js";
import { createSwapRepository } from "./createSwapRepository.js";
import type { SwapRepository } from "../../domain/repositories/SwapRepository.js";

/**
 * Every repository, built on one database handle (the Afriex `createRepositories`). Interactors receive only the
 * ones they use; nothing outside src/db touches Drizzle or SQL. Chain-specific stores (deposit addresses, watcher
 * cursors) are built in bootstrap with createChainRepositories.
 */
export interface Repositories {
  ledger: LedgerRepository;
  vault: CardVaultRepository;
  payouts: PayoutRepository;
  users: UserRepository;
  cards: CardRepository;
  agents: AgentRepository;
  spends: SpendRepository;
  fundings: FundingRepository;
  oneTimeCards: OneTimeCardRepository;
  developers: DeveloperRepository;
  webhookEvents: WebhookEventRepository;
  merchants: MerchantRepository;
  checkouts: CheckoutRepository;
  swaps: SwapRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    ledger: createLedgerStore(db),
    vault: createCardVaultRepository(db),
    payouts: createPayoutRepository(db),
    users: createUserRepository(db),
    cards: createCardRepository(db),
    agents: createAgentRepository(db),
    spends: createSpendRepository(db),
    fundings: createFundingRepository(db),
    oneTimeCards: createOneTimeCardRepository(db),
    developers: createDeveloperRepository(db),
    webhookEvents: createWebhookEventRepository(db),
    merchants: createMerchantRepository(db),
    checkouts: createCheckoutRepository(db),
    swaps: createSwapRepository(db),
  };
}
