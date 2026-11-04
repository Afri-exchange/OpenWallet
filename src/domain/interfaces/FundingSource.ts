export type Stablecoin = "USDC" | "USDT";

export interface FundingRequest {
  cardId: string;
  /** Minor units (cents) of USD value to load. */
  amountCents: number;
  asset: Stablecoin;
  /** Idempotency key so a retried top-up never double-funds. */
  idempotencyKey: string;
}

export interface FundingReceipt {
  id: string;
  status: "pending" | "confirmed" | "failed";
}

/** Converts stablecoin into card balance. One implementation per rail. */
export interface FundingSource {
  fund(req: FundingRequest): Promise<FundingReceipt>;
}
