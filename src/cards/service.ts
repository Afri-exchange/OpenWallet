import type { FundingReceipt, FundingSource, Stablecoin } from "../funding/types.js";
import type { MidenClient } from "../miden/client.js";
import type { SpendPolicy } from "./policy.js";

export interface AgentCard {
  id: string;
  agentId: string;
  policy: SpendPolicy;
}

/**
 * Issues cards for agents and tops them up from stablecoins.
 * TODO: card-issuance endpoint paths/payloads: confirm in the Miden API explorer.
 */
export class CardService {
  constructor(
    private readonly miden: MidenClient,
    private readonly funding: FundingSource,
  ) {}

  async issue(agentId: string, policy: SpendPolicy): Promise<AgentCard> {
    const res = await this.miden.request<{ id: string }>("POST", "/api/v1/cards", { reference: agentId }); // TODO: real path
    return { id: res.id, agentId, policy };
  }

  topUp(card: AgentCard, amountCents: number, asset: Stablecoin, idempotencyKey: string): Promise<FundingReceipt> {
    return this.funding.fund({ cardId: card.id, amountCents, asset, idempotencyKey });
  }
}
