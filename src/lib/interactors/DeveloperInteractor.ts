import { createHash, createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { DeveloperRepository } from "../../domain/repositories/DeveloperRepository.js";
import type { ClaimedWebhookEvent, WebhookEventRepository } from "../../domain/repositories/WebhookEventRepository.js";
import { type CardholderInteractor } from "./CardholderInteractor.js";
import { badRequestError, conflictError, notFoundError } from "../../errors.js";

export interface DeveloperContext {
  developers: DeveloperRepository;
  webhookEvents: WebhookEventRepository;
  app: CardholderInteractor;
  /** Sandbox only: webhooks may go to http://localhost and private addresses (a developer's local server). */
  allowLocalWebhooks: boolean;
  /** Base URL of the hosted pages (KYC, spend controls) handed to end users. */
  publicUrl: string;
  now?: () => Date;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  /** Replaceable in tests: resolves a hostname to the addresses it points at. */
  resolve?: (host: string) => Promise<string[]>;
  log?: (msg: string) => void;
}

const hashKey = (t: string) => createHash("sha256").update(t).digest("hex");
const newId = (prefix: string, bytes = 6) => `${prefix}_${randomBytes(bytes).toString("hex")}`;
const newSecret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export const SESSION_TTL_DEFAULT_S = 3_600;
export const SESSION_TTL_MAX_S = 86_400;
const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 10_000;

/** Event types a developer can receive. */
export const EVENT_TYPES = ["kyc.updated", "card.issued", "funding.completed", "spend.settled"] as const;

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw badRequestError(`${what} is required`);
  if (v.length > max) throw badRequestError(`${what} is too long`);
  return v.trim();
}

/** Expands an IPv6 address into its eight 16-bit groups, or undefined if it is not a valid IPv6 literal. */
function ipv6Groups(ip: string): number[] | undefined {
  let v = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const o = dotted[1]!.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return undefined;
    v = v.slice(0, -dotted[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = v.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

/**
 * True for anything that is not an ordinary public unicast address. IPv6 forms that wrap an IPv4 address
 * (mapped, NAT64, 6to4, compatible) are unwrapped and judged by the IPv4 rules, or rejected outright.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const g = isIP(ip) === 6 ? ipv6Groups(ip) : undefined;
  if (!g) return true; // not an address we can reason about
  const v4 = (hi: number, lo: number) => isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6]!, g[7]!); // mapped, compatible, ::, ::1
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 6to4
  if (g[0] === 0) return true; // ::/16 remainder
  const top = g[0]! & 0xffc0;
  return (g[0]! & 0xfe00) === 0xfc00 || top === 0xfe80 || top === 0xfec0 || (g[0]! & 0xff00) === 0xff00 || (g[0]! === 0x2001 && g[1]! === 0xdb8);
}

/**
 * The developer layer. A developer holds a key (`dk_...`), creates end users under their account, hands each user a
 * short-lived session for the hosted KYC and spend-control pages, controls their agents, and gets signed webhooks.
 * A developer only ever reaches their own users, and never sees a user's identity documents: KYC goes from the
 * user's browser (session token) straight to Miden.
 */
export class DeveloperInteractor {
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private deliveryRun: Promise<void> | undefined;

  constructor(private readonly d: DeveloperContext) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
  }

  // ---------- accounts ----------

  async signup(body: { name?: unknown; email?: unknown }): Promise<{ developerId: string; key: string }> {
    const name = text(body.name, "name", 120);
    const email = text(body.email, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequestError("email is not valid");
    const developerId = newId("dev");
    const key = newSecret("dk");
    if (!(await this.d.developers.create({ id: developerId, name, email, keyHash: hashKey(key) }))) {
      throw conflictError("that email already has a developer account");
    }
    return { developerId, key };
  }

  async byKey(key: string): Promise<string | undefined> {
    return this.d.developers.idByKeyHash(hashKey(key));
  }

  async rotateKey(developerId: string): Promise<{ key: string }> {
    const key = newSecret("dk");
    await this.d.developers.setKeyHash(developerId, hashKey(key));
    // A rotated key means "something may have leaked": the browser sessions it minted go too.
    await this.d.developers.deleteSessions(developerId);
    return { key };
  }

  async profile(developerId: string) {
    const r = await this.d.developers.find(developerId);
    if (!r) throw notFoundError("developer not found");
    const users = await this.d.developers.countUsers(developerId);
    return { developerId, name: r.name, email: r.email, privacyMode: r.privacyMode, webhookUrl: r.webhookUrl, users, events: [...EVENT_TYPES] };
  }

  /**
   * privacyMode: the default for users created from now on (each payment by their agents uses a fresh one-time card).
   * Existing users keep the mode they were created with.
   * webhookUrl: where signed events go (null removes it). A new URL gets a new signing secret, returned once.
   */
  async updateSettings(developerId: string, body: { privacyMode?: unknown; webhookUrl?: unknown }): Promise<{ privacyMode: boolean; webhookUrl: string | null; webhookSecret?: string }> {
    const out: { privacyMode: boolean; webhookUrl: string | null; webhookSecret?: string } = { privacyMode: false, webhookUrl: null };
    if (body.privacyMode !== undefined) {
      if (typeof body.privacyMode !== "boolean") throw badRequestError("privacyMode must be true or false");
      await this.d.developers.setPrivacyMode(developerId, body.privacyMode);
    }
    if (body.webhookUrl !== undefined) {
      if (body.webhookUrl === null || body.webhookUrl === "") {
        await this.d.developers.setWebhook(developerId, null, null);
      } else {
        const url = await this.checkWebhookUrl(body.webhookUrl);
        const secret = newSecret("whsec");
        await this.d.developers.setWebhook(developerId, url.href, secret);
        out.webhookSecret = secret;
      }
    }
    const r = await this.d.developers.find(developerId);
    // As before: an unknown developer id fails here (there is no row to read back).
    if (!r) throw new TypeError(`developer ${developerId} not found`);
    out.privacyMode = r.privacyMode;
    out.webhookUrl = r.webhookUrl;
    return out;
  }

  async privacyMode(developerId: string): Promise<boolean> {
    return (await this.d.developers.find(developerId))?.privacyMode === true;
  }

  // ---------- end users ----------

  async createUser(developerId: string, body: { externalId?: unknown; email?: unknown; privacyMode?: unknown }) {
    const { userId, created } = await this.d.app.createManagedUser(developerId, body.externalId, body.email, body.privacyMode);
    return { created, user: await this.userView(developerId, userId) };
  }

  async listUsers(developerId: string, limit: number, externalId?: string) {
    const ids = await this.d.developers.listUserIds(developerId, Math.min(Math.max(limit, 1), 100), externalId);
    return Promise.all(ids.map((id) => this.userView(developerId, id)));
  }

  async userView(developerId: string, userId: string) {
    await this.owned(developerId, userId);
    const o = await this.d.app.overview(userId);
    const owner = (await this.d.app.userOwner(userId))!;
    return { ...o, externalId: owner.externalId };
  }

  /** Throws 404 (not 403) for a user who is not this developer's, so ids cannot be probed. */
  async owned(developerId: string, userId: string): Promise<void> {
    const owner = await this.d.app.userOwner(userId);
    if (!owner || owner.developerId !== developerId) throw notFoundError("user not found");
  }

  /** A session for the user's browser: the hosted KYC and spend-control pages live behind it. */
  async createSession(developerId: string, userId: string, ttlSecondsIn?: unknown) {
    let ttl = SESSION_TTL_DEFAULT_S;
    if (ttlSecondsIn !== undefined) {
      if (typeof ttlSecondsIn !== "number" || !Number.isInteger(ttlSecondsIn) || ttlSecondsIn < 60 || ttlSecondsIn > SESSION_TTL_MAX_S) {
        throw badRequestError(`ttlSeconds must be a whole number from 60 to ${SESSION_TTL_MAX_S}`);
      }
      ttl = ttlSecondsIn;
    }
    const s = await this.d.app.createSession(developerId, userId, ttl);
    // The token travels in the URL fragment, so it is never sent to a server or written to an access log.
    return { token: s.token, expiresAt: s.expiresAt, url: `${this.d.publicUrl.replace(/\/$/, "")}/connect#session=${s.token}` };
  }

  /** Ends every browser session of one of the developer's users. */
  async revokeSessions(developerId: string, userId: string): Promise<{ revoked: number }> {
    await this.owned(developerId, userId);
    return { revoked: await this.d.developers.deleteSessions(developerId, userId) };
  }

  // ---------- agents (the developer controls a user's agents) ----------

  async createAgent(developerId: string, userId: string, body: Parameters<CardholderInteractor["createAgent"]>[1]) {
    await this.owned(developerId, userId);
    return this.d.app.createAgent(userId, body);
  }
  async updateAgentLimits(developerId: string, userId: string, agentId: string, body: Parameters<CardholderInteractor["updateAgentLimits"]>[2]) {
    await this.owned(developerId, userId);
    return this.d.app.updateAgentLimits(userId, agentId, body);
  }
  async fundAgent(developerId: string, userId: string, agentId: string, amountCents: unknown, key?: unknown) {
    await this.owned(developerId, userId);
    await this.d.app.fundAgent(userId, agentId, amountCents, key);
  }
  async reclaimAgent(developerId: string, userId: string, agentId: string, amountCents?: unknown) {
    await this.owned(developerId, userId);
    return this.d.app.reclaimAgent(userId, agentId, amountCents);
  }
  async revokeAgent(developerId: string, userId: string, agentId: string) {
    await this.owned(developerId, userId);
    await this.d.app.revokeAgent(userId, agentId);
  }

  // ---------- webhooks ----------

  private async checkWebhookUrl(v: unknown): Promise<URL> {
    let url: URL;
    try {
      url = new URL(String(v));
    } catch {
      throw badRequestError("webhookUrl is not a valid URL");
    }
    if (url.username || url.password) throw badRequestError("webhookUrl must not contain credentials");
    const local = this.d.allowLocalWebhooks && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw badRequestError("webhookUrl must be https");
    if (!local) await this.assertPublicHost(url.hostname);
    return url;
  }

  private async resolveHost(host: string): Promise<string[]> {
    if (this.d.resolve) return this.d.resolve(host);
    const bare = host.replace(/^\[|\]$/g, "");
    if (isIP(bare)) return [bare];
    return (await lookup(bare, { all: true })).map((a) => a.address);
  }

  /** Webhooks must not be a way to reach our own network. Checked when the URL is set and again at every delivery. */
  private async assertPublicHost(host: string): Promise<void> {
    if (this.d.allowLocalWebhooks) return;
    let addrs: string[];
    try {
      addrs = await this.resolveHost(host);
    } catch {
      throw badRequestError("webhookUrl host does not resolve");
    }
    if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw badRequestError("webhookUrl must point at a public address");
  }

  /** The CardholderInteractor hook: queues the event for the user's developer, if they have one and it has a webhook. */
  readonly onEvent = async (userId: string, type: string, data: Record<string, unknown>): Promise<void> => {
    const owner = await this.d.app.userOwner(userId);
    if (!owner?.developerId) return;
    const dev = await this.d.developers.find(owner.developerId);
    if (!dev?.webhookUrl) return;
    const id = newId("evt", 12);
    const body = JSON.stringify({ id, type, createdAt: this.now().toISOString(), userId, externalId: owner.externalId, data });
    await this.d.webhookEvents.enqueue({ id, developerId: owner.developerId, type, body, nextAttemptAt: this.now() });
  };

  /** Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the webhook secret>`. Reject old `t` to stop replays. */
  static sign(secret: string, timestamp: number, body: string): string {
    return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  }

  /** Delivers due events, one run at a time. Failed ones back off (30s, 1m, 2m ... up to 6h) and give up after 8 tries. */
  deliverDue(): Promise<void> {
    this.deliveryRun ??= this.doDeliver().finally(() => (this.deliveryRun = undefined));
    return this.deliveryRun;
  }

  private async doDeliver(): Promise<void> {
    const doFetch = this.d.fetch ?? fetch;
    // Finished events are history, not a queue: keep 30 days.
    await this.d.webhookEvents.purgeFinishedBefore(new Date(this.now().getTime() - 30 * 86_400_000)).catch(() => undefined);
    for (;;) {
      // Claim one due event; SKIP LOCKED lets several processes share the queue. The claim pushes next_attempt_at out
      // so a crash mid-delivery means a retry later, not a stuck row.
      const ev = await this.d.webhookEvents.claimDue(this.now(), new Date(this.now().getTime() + 5 * 60_000));
      if (!ev) return;
      await this.deliverOne(ev, doFetch);
    }
  }

  private async deliverOne(ev: ClaimedWebhookEvent, doFetch: typeof fetch): Promise<void> {
    const fail = async (why: string) => {
      const attempts = ev.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await this.d.webhookEvents.markFailed(ev.id, attempts, why);
        this.log(`webhook ${ev.id}: gave up after ${attempts} tries: ${why}`);
      } else {
        const wait = Math.min(30_000 * 2 ** (attempts - 1), 6 * 3_600_000);
        await this.d.webhookEvents.scheduleRetry(ev.id, attempts, why, new Date(this.now().getTime() + wait));
      }
    };
    const { webhookUrl, webhookSecret } = ev;
    if (!webhookUrl || !webhookSecret) {
      // The developer removed their webhook after the event was queued.
      await this.d.webhookEvents.abandon(ev.id, "no webhook configured");
      return;
    }
    try {
      const url = new URL(webhookUrl);
      await this.assertPublicHost(url.hostname);
      const ts = Math.floor(this.now().getTime() / 1000);
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentcards-event-id": ev.id,
          "x-agentcards-signature": DeveloperInteractor.sign(webhookSecret, ts, ev.body),
        },
        body: ev.body,
        redirect: "manual", // a redirect could point somewhere we would not have allowed
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) {
        await this.d.webhookEvents.markDelivered(ev.id);
      } else {
        await fail(`HTTP ${res.status}`);
      }
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** What the developer's webhook has received, for debugging. Bodies are not returned. */
  async listEvents(developerId: string, limit: number) {
    const rows = await this.d.webhookEvents.listForDeveloper(developerId, Math.min(Math.max(limit, 1), 100));
    return rows.map((r) => ({
      id: r.id, type: r.type, status: r.status as string, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt, deliveredAt: r.deliveredAt,
    }));
  }
}
