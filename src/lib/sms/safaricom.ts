/**
 * Safaricom SMS provider (pilot decision, 24 Nov 2026).
 *
 * TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM SMS INTEGRATION
 *   1. Get the Bulk SMS / SDP account, approved sender ID and API contract
 *      from Safaricom (or a Safaricom-approved aggregator).
 *   2. Fill buildRequest() below with the exact endpoint, headers and JSON
 *      body from that contract, and read the provider's message id in
 *      parseResponse(). Everything around it (token caching, retries,
 *      number format, 160-character text, outbox bookkeeping) is done.
 *   3. Set the environment variables listed in SafaricomConfig on the worker
 *      only (never in the Next.js app or the browser).
 * Until step 2 is done, send() refuses with a clear "not configured" error and
 * nothing is marked as sent.
 */
import type { SmsMessage, SmsProvider, SmsResult } from "./index";

export type SafaricomConfig = {
  /** OAuth token endpoint from the Safaricom contract. */
  tokenUrl: string;
  /** Send endpoint from the Safaricom contract. */
  sendUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Approved alphanumeric sender ID, for example the ISP's or FibrePulse's name. */
  senderId: string;
  timeoutMs: number;
};

export function safaricomConfig(env: Record<string, string | undefined> = process.env): SafaricomConfig {
  const need = ["SAFARICOM_SMS_TOKEN_URL", "SAFARICOM_SMS_SEND_URL", "SAFARICOM_SMS_CONSUMER_KEY", "SAFARICOM_SMS_CONSUMER_SECRET", "SAFARICOM_SMS_SENDER_ID"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Safaricom SMS is not configured. Missing: ${missing.join(", ")}.`);
  for (const k of ["SAFARICOM_SMS_TOKEN_URL", "SAFARICOM_SMS_SEND_URL"]) {
    if (!/^https:\/\//.test(env[k]!)) throw new Error(`${k} must be an https:// URL.`);
  }
  return {
    tokenUrl: env.SAFARICOM_SMS_TOKEN_URL!,
    sendUrl: env.SAFARICOM_SMS_SEND_URL!,
    consumerKey: env.SAFARICOM_SMS_CONSUMER_KEY!,
    consumerSecret: env.SAFARICOM_SMS_CONSUMER_SECRET!,
    senderId: env.SAFARICOM_SMS_SENDER_ID!,
    timeoutMs: 15_000,
  };
}

/** Replace with the request from Safaricom's API contract (step 2 above). */
export function buildRequest(cfg: SafaricomConfig, accessToken: string, m: SmsMessage): RequestInit | null {
  void cfg;
  void accessToken;
  void m;
  // TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM SMS INTEGRATION (request body and headers)
  return null;
}

/** Replace with how the contract reports acceptance and the message id. */
export function parseResponse(status: number, body: unknown): SmsResult {
  // TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM SMS INTEGRATION (response handling)
  void body;
  if (status >= 500 || status === 429) return { ok: false, retry: true, error: `Safaricom answered HTTP ${status}.` };
  return { ok: false, retry: false, error: `Response handling not implemented (HTTP ${status}).` };
}

export class SafaricomSmsProvider implements SmsProvider {
  readonly name = "safaricom";
  readonly delivers = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: SafaricomConfig, private fetchFn: typeof fetch = fetch) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString("base64");
    const res = await this.fetchFn(this.cfg.tokenUrl, { headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!res.ok) throw new Error(`Safaricom token request failed (HTTP ${res.status}).`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number | string };
    if (!json.access_token) throw new Error("Safaricom token response had no access_token.");
    this.token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3599) * 1000 };
    return this.token.value;
  }

  async send(m: SmsMessage): Promise<SmsResult> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (e) {
      return { ok: false, retry: true, error: (e as Error).message };
    }
    const req = buildRequest(this.cfg, token, m);
    if (!req) return { ok: false, retry: true, error: "Safaricom SMS sending is not implemented yet (see src/lib/sms/safaricom.ts)." };
    try {
      const res = await this.fetchFn(this.cfg.sendUrl, { ...req, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      return parseResponse(res.status, await res.json().catch(() => null));
    } catch (e) {
      return { ok: false, retry: true, error: `Could not reach Safaricom: ${(e as Error).message}` };
    }
  }
}
