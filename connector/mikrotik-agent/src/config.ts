import { readFileSync } from "node:fs";

export type LocalCredentials = Record<string, { username: string; password: string }>;

export type AgentConfig = {
  cloudUrl: string;
  token: string;
  pollIntervalMs: number;
  syncIntervalMs: number;
  requestTimeoutMs: number;
  allowWrites: boolean;
  simulate: boolean;
  localCredentials: LocalCredentials;
  maxBufferedBatches: number;
};

const bool = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");
const seconds = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, min), max) : fallback) * 1000;
};

/** Read and validate settings. Throws a readable error for the operator. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const url = (env.FIBREPULSE_URL ?? "").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("FIBREPULSE_URL is missing or not a valid URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local) throw new Error("FIBREPULSE_URL must use https:// (plain http is allowed only for localhost testing).");
  const token = (env.FIBREPULSE_TOKEN ?? "").trim();
  if (!/^fpc_[A-Za-z0-9]{32,100}$/.test(token)) throw new Error("FIBREPULSE_TOKEN is missing or malformed. Copy it from FibrePulse when you register the connector.");

  let localCredentials: LocalCredentials = {};
  if (env.ROUTER_CREDENTIALS_FILE) {
    try {
      localCredentials = JSON.parse(readFileSync(env.ROUTER_CREDENTIALS_FILE, "utf8")) as LocalCredentials;
    } catch {
      throw new Error(`Could not read ROUTER_CREDENTIALS_FILE (${env.ROUTER_CREDENTIALS_FILE}). It must be JSON.`);
    }
  }

  return {
    cloudUrl: url,
    token,
    pollIntervalMs: seconds(env.POLL_INTERVAL_SECONDS, 60, 15, 3600),
    syncIntervalMs: seconds(env.SYNC_INTERVAL_SECONDS, 15, 5, 600),
    requestTimeoutMs: seconds(env.REQUEST_TIMEOUT_SECONDS, 10, 2, 60),
    allowWrites: bool(env.ALLOW_ROUTER_WRITES),
    simulate: bool(env.SIMULATE),
    localCredentials,
    maxBufferedBatches: 120,
  };
}
