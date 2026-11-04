import type { AppResponse } from "../../domain/types/RequestTypes.js";

/** Sends a JSON body. API responses are never cached. */
export function sendJson(res: AppResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A `limit` query parameter as a whole number, or the default when it is missing, zero or not a number. */
export function limitOf(query: URLSearchParams, fallback = 20): number {
  return Math.trunc(Number(query.get("limit") ?? fallback)) || fallback;
}
