/**
 * Errors the HTTP layer may show to the caller as-is.
 *
 * Throw one of the factories below rather than `new AgentCardsError(...)`: each picks the code, and the code
 * picks the HTTP status. Anything thrown that is not an AgentCardsError is a 500 and its message is never shown.
 * `meta` is for logs only; it is never sent to the caller.
 */
export enum ErrorCodes {
  badRequest = "bad_request",
  unauthorized = "unauthorized",
  forbidden = "forbidden",
  notFound = "not_found",
  conflict = "conflict",
  gone = "gone",
  tooLarge = "payload_too_large",
  unsupportedMediaType = "unsupported_media_type",
  misdirected = "misdirected_request",
  unprocessable = "unprocessable",
  tooManyRequests = "too_many_requests",
  internal = "internal_error",
  badGateway = "bad_gateway",
  unavailable = "service_unavailable",
}

const STATUS: Record<ErrorCodes, number> = {
  [ErrorCodes.badRequest]: 400,
  [ErrorCodes.unauthorized]: 401,
  [ErrorCodes.forbidden]: 403,
  [ErrorCodes.notFound]: 404,
  [ErrorCodes.conflict]: 409,
  [ErrorCodes.gone]: 410,
  [ErrorCodes.tooLarge]: 413,
  [ErrorCodes.unsupportedMediaType]: 415,
  [ErrorCodes.misdirected]: 421,
  [ErrorCodes.unprocessable]: 422,
  [ErrorCodes.tooManyRequests]: 429,
  [ErrorCodes.internal]: 500,
  [ErrorCodes.badGateway]: 502,
  [ErrorCodes.unavailable]: 503,
};

export type ErrorMeta = Record<string, unknown>;

export class AgentCardsError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCodes = ErrorCodes.internal,
    readonly meta: ErrorMeta = {},
  ) {
    super(message);
    this.name = "AgentCardsError";
  }

  /** The HTTP status for this error's code. */
  get status(): number {
    return STATUS[this.code];
  }
}

const factory = (code: ErrorCodes) => (message: string, meta?: ErrorMeta) => new AgentCardsError(message, code, meta);

export const badRequestError = factory(ErrorCodes.badRequest);
export const unauthorizedError = factory(ErrorCodes.unauthorized);
export const forbiddenError = factory(ErrorCodes.forbidden);
export const notFoundError = factory(ErrorCodes.notFound);
export const conflictError = factory(ErrorCodes.conflict);
export const goneError = factory(ErrorCodes.gone);
export const payloadTooLargeError = factory(ErrorCodes.tooLarge);
export const unsupportedMediaTypeError = factory(ErrorCodes.unsupportedMediaType);
export const misdirectedRequestError = factory(ErrorCodes.misdirected);
export const unprocessableError = factory(ErrorCodes.unprocessable);
export const tooManyRequestsError = factory(ErrorCodes.tooManyRequests);
export const badGatewayError = factory(ErrorCodes.badGateway);
export const unavailableError = factory(ErrorCodes.unavailable);

/** The HTTP status for anything thrown: an AgentCardsError's own status, otherwise 500. */
export const statusOf = (e: unknown): number => (e instanceof AgentCardsError ? e.status : 500);
