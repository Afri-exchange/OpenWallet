import type { MidenClient } from "../miden/client.js";
import type { FundingReceipt, FundingRequest, FundingSource } from "./types.js";

/**
 * Stablecoin funding via Miden Wallet-as-a-Service / collections.
 * TODO: endpoint paths and payloads are not in the getting-started page;
 * fill in from the API explorer at docs.miden.co.
 */
export class MidenWalletFunding implements FundingSource {
  constructor(private readonly miden: MidenClient) {}

  async fund(_req: FundingRequest): Promise<FundingReceipt> {
    void this.miden;
    throw new Error("MidenWalletFunding.fund not implemented: confirm WaaS endpoints");
  }
}
