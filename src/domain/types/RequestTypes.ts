import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentPrincipal } from "../../lib/interactors/CardholderInteractor.js";

/**
 * A request as controllers see it. Auth middleware fills the caller fields; controllers read the caller only
 * from here, never from the body or query (the Afriex `req.headers.callerId` rule).
 */
export interface AppRequest extends IncomingMessage {
  /** The path without the query, relative to the router it reached (a mounted router sees its own sub-path). */
  path: string;
  /** The full path, unaffected by mounting. */
  originalPath: string;
  query: URLSearchParams;
  /** Named path parameters from the matched route. */
  params: Record<string, string>;
  /** The parsed JSON object, after the `jsonBody` middleware. */
  body: Record<string, unknown>;
  /** The raw UTF-8 body, after the `rawBody` middleware (signature checks need the exact bytes). */
  rawBody: string;
  /** After `authorizeUser` / `authorizeMerchant` / `authorizeDeveloper`: the authenticated user, merchant or developer id. */
  callerId?: string;
  /** After `authorizeAgent`: the agent and the card it spends from. */
  agent?: AgentPrincipal;
}

export type AppResponse = ServerResponse;

/**
 * A route handler or middleware. Middleware returns without ending the response to pass control on, or throws
 * an AgentCardsError to refuse; the last handler of a route ends the response.
 */
export type Handler = (req: AppRequest, res: AppResponse) => Promise<void> | void;
