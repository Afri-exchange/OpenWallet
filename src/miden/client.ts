import { newReference, sign, type SignatureMode } from "./signature.js";

export interface MidenConfig {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  uniqueKey: string;
  signatureMode?: SignatureMode;
  fetch?: typeof fetch;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): MidenConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing env var ${k}`);
    return v;
  };
  return {
    baseUrl: need("MIDEN_BASE_URL"),
    tokenUrl: need("MIDEN_TOKEN_URL"),
    clientId: need("MIDEN_CLIENT_ID"),
    clientSecret: need("MIDEN_CLIENT_SECRET"),
    uniqueKey: need("MIDEN_UNIQUE_KEY"),
    signatureMode: (env.MIDEN_SIGNATURE_MODE as SignatureMode | undefined) ?? "base64-of-hex",
  };
}

/** Thin signed client for the Miden Workspace API. */
export class MidenClient {
  private token?: { value: string; expiresAt: number };
  private readonly f: typeof fetch;

  constructor(private readonly cfg: MidenConfig) {
    this.f = cfg.fetch ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.f(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`Miden token request failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const reference = newReference();
    const res = await this.f(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Reference: reference,
        Signature: sign({ method, url, reference, clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }, this.cfg.signatureMode),
        UniqueKey: this.cfg.uniqueKey,
        MidenAuthorization: `MidenAuth ${Buffer.from(this.cfg.clientId).toString("base64")}`,
        Authorization: `Bearer ${await this.accessToken()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Miden ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}
