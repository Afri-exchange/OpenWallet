import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type * as t from "../../db/schema/index.js";

// Stored records as the repositories return them (camelCase, BIGINT amounts as safe JS numbers, timestamps as Date).
// Derived from the Drizzle schema, so a column added there is a type error everywhere it matters.

export type User = InferSelectModel<typeof t.appUser>;
export type Card = InferSelectModel<typeof t.appCard>;
export type Agent = InferSelectModel<typeof t.appAgent>;
export type Spend = InferSelectModel<typeof t.appSpend>;
export type NewSpend = InferInsertModel<typeof t.appSpend>;
export type Funding = InferSelectModel<typeof t.appFunding>;
export type OneTimeCard = InferSelectModel<typeof t.appOneTimeCard>;
export type Developer = InferSelectModel<typeof t.appDeveloper>;
export type Session = InferSelectModel<typeof t.appSession>;
export type WebhookEvent = InferSelectModel<typeof t.appWebhookEvent>;
export type Merchant = InferSelectModel<typeof t.appMerchant>;
export type Checkout = InferSelectModel<typeof t.appCheckout>;
export type Payout = InferSelectModel<typeof t.appPayout>;
export type CheckoutSwap = InferSelectModel<typeof t.appCheckoutSwap>;
export type NewCheckoutSwap = InferInsertModel<typeof t.appCheckoutSwap>;
export type DepositAddress = InferSelectModel<typeof t.depositAddress>;
export type SealedCardRecord = InferSelectModel<typeof t.cardVault>;

export type { SpendStatus, CheckoutStatus, PayoutStatus, SwapStatus } from "../../db/schema/index.js";
