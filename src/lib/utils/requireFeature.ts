import type { AgentCardsApp } from "../../createApp.js";
import type { CircleDeposits } from "../../adapters/deposits/CircleDeposits.js";
import type { CheckoutInteractor } from "../interactors/CheckoutInteractor.js";
import type { DeveloperInteractor } from "../interactors/DeveloperInteractor.js";
import type { SwapInteractor } from "../interactors/SwapInteractor.js";
import { notFoundError } from "../../errors.js";

// Optional features: a server started without them answers 404 on their routes.

export function requireCheckouts(app: AgentCardsApp): CheckoutInteractor {
  if (!app.checkouts) throw notFoundError("checkouts are not enabled on this server");
  return app.checkouts;
}

export function requireSwaps(app: AgentCardsApp): SwapInteractor {
  if (!app.swaps) throw notFoundError("paying hosted checkouts is not enabled on this server");
  return app.swaps;
}

export function requireDevelopers(app: AgentCardsApp): DeveloperInteractor {
  if (!app.developers) throw notFoundError("the developer API is not enabled on this server");
  return app.developers;
}

export function requireCircleDeposits(app: AgentCardsApp): CircleDeposits {
  if (!app.circleDeposits) throw notFoundError("Circle deposits are not enabled on this server");
  return app.circleDeposits;
}
