import type { Handler } from "../../domain/types/RequestTypes.js";

/**
 * Wraps a controller method (the Afriex convention). Errors propagate to the server's error handler, which
 * turns an AgentCardsError into its status and anything else into a logged 500.
 */
const createControllerMethod = (handler: Handler): Handler => async (req, res) => {
  await handler(req, res);
};

export default createControllerMethod;
