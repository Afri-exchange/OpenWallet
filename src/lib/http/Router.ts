import type { AppRequest, AppResponse, Handler } from "../../domain/types/RequestTypes.js";
import { notFoundError } from "../../errors.js";

/**
 * A small Express-shaped router over node:http (we keep node:http rather than pull in Express: the request
 * guards here were written and tested against it). Routes match in registration order; the first match wins.
 *
 * Path patterns: literal segments, `:name` (one segment) and `:name(regex)` (one segment matching regex), or a
 * RegExp whose named groups become params. Paths match exactly: "/a" and "/a/" are different routes.
 */
type Matcher = (path: string) => Record<string, string> | undefined;

interface Route { methods: Set<string> | "*"; match: Matcher; handlers: Handler[] }
interface Mount { prefix: string; strip: string; handlers: Handler[]; router: Router }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(pattern: string | RegExp): Matcher {
  if (pattern instanceof RegExp) {
    const re = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace("g", ""));
    return (path) => {
      const m = re.exec(path);
      return m ? { ...(m.groups ?? {}) } : undefined;
    };
  }
  const names: string[] = [];
  const source = pattern.replace(/:([A-Za-z_]\w*)(?:\(([^)]+)\))?|[^:]+/g, (part, name?: string, re?: string) => {
    if (!name) return escapeRe(part);
    names.push(name);
    return `(${re ?? "[^/]+"})`;
  });
  const re = new RegExp(`^${source}$`);
  return (path) => {
    const m = re.exec(path);
    if (!m) return undefined;
    return Object.fromEntries(names.map((n, i) => [n, m[i + 1]!]));
  };
}

export class Router {
  private readonly entries: Array<{ route: Route } | { mount: Mount } | { include: Router }> = [];

  on(methods: string[] | "*", pattern: string | RegExp, ...handlers: Handler[]): this {
    this.entries.push({ route: { methods: methods === "*" ? "*" : new Set(methods), match: compile(pattern), handlers } });
    return this;
  }

  get(pattern: string | RegExp, ...handlers: Handler[]): this { return this.on(["GET"], pattern, ...handlers); }
  post(pattern: string | RegExp, ...handlers: Handler[]): this { return this.on(["POST"], pattern, ...handlers); }
  delete(pattern: string | RegExp, ...handlers: Handler[]): this { return this.on(["DELETE"], pattern, ...handlers); }
  all(pattern: string | RegExp, ...handlers: Handler[]): this { return this.on("*", pattern, ...handlers); }

  /**
   * Mounts a router for every path that starts with `prefix` (plain string prefix, as written). The mount's
   * middleware runs first (auth, typically), so an unknown path under it is refused the same way as a known
   * one; then the sub-router, which sees the path with `prefix` minus any trailing slash removed. A path under
   * the prefix that the sub-router does not know is a 404: mounts are terminal.
   */
  use(prefix: string, ...rest: [...Handler[], Router]): this {
    const router = rest[rest.length - 1] as Router;
    const handlers = rest.slice(0, -1) as Handler[];
    this.entries.push({ mount: { prefix, strip: prefix.replace(/\/$/, ""), handlers, router } });
    return this;
  }

  /** Adds another router's routes at this level, unprefixed (non-terminal: no match there means keep looking). */
  include(router: Router): this {
    this.entries.push({ include: router });
    return this;
  }

  /** Runs the first matching route. Returns false if nothing here matched (the caller decides what that means). */
  async handle(req: AppRequest, res: AppResponse): Promise<boolean> {
    const method = req.method ?? "GET";
    const path = req.path;
    for (const e of this.entries) {
      if ("include" in e) {
        if (await e.include.handle(req, res)) return true;
        continue;
      }
      if ("mount" in e) {
        if (!path.startsWith(e.mount.prefix)) continue;
        if (!(await run(e.mount.handlers, req, res))) return true;
        req.path = path.slice(e.mount.strip.length);
        try {
          if (await e.mount.router.handle(req, res)) return true;
        } finally {
          req.path = path;
        }
        throw notFoundError("not found");
      }
      const { route } = e;
      if (route.methods !== "*" && !route.methods.has(method)) continue;
      const params = route.match(path);
      if (!params) continue;
      req.params = { ...req.params, ...params };
      await run(route.handlers, req, res);
      return true;
    }
    return false;
  }
}

/** Runs handlers in order until one ends the response. Returns true if the response is still open. */
async function run(handlers: Handler[], req: AppRequest, res: AppResponse): Promise<boolean> {
  for (const h of handlers) {
    await h(req, res);
    if (res.headersSent || res.writableEnded) return false;
  }
  return true;
}
