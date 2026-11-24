/** Signed HTTPS calls to FibrePulse. */
import { randomBytes } from "node:crypto";
import { sign } from "./signature.js";

export class CloudError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type RouterConfig = {
  id: string;
  name: string;
  address: string | null;
  port: number | null;
  scheme: "https" | "http";
  verify_tls: boolean;
  simulated: boolean;
  username: string | null;
  password: string | null;
  credential_error: string | null;
};

export type CommandType = "disconnect_pppoe" | "reconnect_pppoe" | "disconnect_hotspot";

/** pppoe_username holds the hotspot access code for disconnect_hotspot. */
export type Command = { id: string; router_id: string; type: CommandType; pppoe_username: string };

export type RadiusEntry = {
  username: string;
  /** "pppoe" (monthly customers, password kept by RADIUS) or "hotspot" (an access code). Missing means pppoe. */
  kind?: "pppoe" | "hotspot";
  allowed: boolean;
  download_mbps: number | null;
  upload_mbps: number | null;
  /** When access ends. Null for a hotspot code that has not been used yet. */
  expires_at: string | null;
  /** Hotspot: time bought, in seconds; the clock starts at first login. */
  duration_seconds?: number | null;
  /** Hotspot: the one device (MAC) the code works on, once known. */
  mac?: string | null;
};

export type SyncResponse = {
  agent_id: string;
  tenant_id: string;
  poll_interval_seconds: number;
  router_enforcement: boolean;
  access_control?: "router_secrets" | "radius";
  /** Present only when the ISP uses RADIUS and enforcement is on. */
  radius_access?: RadiusEntry[] | null;
  routers: RouterConfig[];
  commands: Command[];
  /** Changes whenever radius_access would change. Sent back on the next sync. */
  radius_version?: string | null;
  /** IP address each router pings to check the internet from the provider. */
  upstream_check_target?: string | null;
};

export class CloudClient {
  constructor(private baseUrl: string, private token: string, private timeoutMs: number) {}

  async post<T>(path: string, body: unknown): Promise<T> {
    const text = JSON.stringify(body ?? {});
    const ts = new Date().toISOString();
    const nonce = randomBytes(16).toString("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          "x-fibrepulse-timestamp": ts,
          "x-fibrepulse-nonce": nonce,
          "x-fibrepulse-signature": sign(this.token, ts, nonce, "POST", path, text),
          "user-agent": "fibrepulse-mikrotik-agent",
        },
        body: text,
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new CloudError(res.status, out.error ?? `HTTP ${res.status}`);
      return out as T;
    } catch (e) {
      if (e instanceof CloudError) throw e;
      throw new CloudError(0, e instanceof Error && e.name === "AbortError" ? "FibrePulse did not answer in time." : `Cannot reach FibrePulse: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  sync(version: string, radiusVersion: string | null = null) {
    return this.post<SyncResponse>("/api/connector/v1/sync", { version, radius_version: radiusVersion });
  }
  ingest(payload: unknown) {
    return this.post<{ accepted: number; rejected: { router_id: string; reason: string }[] }>("/api/connector/v1/ingest", payload);
  }
  commandResult(commandId: string, success: boolean, message: string) {
    return this.post<{ ok: true }>("/api/connector/v1/commands", { command_id: commandId, success, message: message.slice(0, 300) });
  }
}
