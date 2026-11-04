import type { AppRequest, Handler } from "../../domain/types/RequestTypes.js";
import { badRequestError, payloadTooLargeError } from "../../errors.js";

export const MAX_BODY_BYTES = 2_000_000;

async function readBody(req: AppRequest): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw payloadTooLargeError("request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parses the body as a JSON object into `req.body`. An empty body is `{}`; anything but an object is a 400. */
export const jsonBody: Handler = async (req) => {
  const raw = await readBody(req);
  if (!raw.length) {
    req.body = {};
    return;
  }
  try {
    const v = JSON.parse(raw.toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    req.body = v as Record<string, unknown>;
  } catch {
    throw badRequestError("body must be a JSON object");
  }
};

/** Keeps the exact body text in `req.rawBody`, for webhook signature checks. */
export const rawBody: Handler = async (req) => {
  req.rawBody = (await readBody(req)).toString("utf8");
};
