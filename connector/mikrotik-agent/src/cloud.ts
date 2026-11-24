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

export type Command = { id: string; router_id: string; type: "disconnect_pppoe" | "reconnect_pppoe"; pppoe_username: string };

export type SyncResponse = {
  agent_id: string;
  tenant_id: string;
  poll_interval_seconds: number;
  router_enforcement: boolean;
  routers: RouterConfig[];
  commands: Command[];
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

  sync(version: string) {
    return this.post<SyncResponse>("/api/connector/v1/sync", { version });
  }
  ingest(payload: unknown) {
    return this.post<{ accepted: number; rejected: { router_id: string; reason: string }[] }>("/api/connector/v1/ingest", payload);
  }
  commandResult(commandId: string, success: boolean, message: string) {
    return this.post<{ ok: true }>("/api/connector/v1/commands", { command_id: commandId, success, message: message.slice(0, 300) });
  }
}
