/**
 * RADIUS policy for ISPs that authenticate PPPoE customers with RADIUS.
 *
 * FibrePulse decides WHO may connect and at WHAT speed; the ISP's own RADIUS
 * server (for example FreeRADIUS) still checks the customer's password, so
 * PPPoE passwords never leave the ISP's network. FreeRADIUS asks this
 * connector over HTTP on the local network (rlm_rest, "authorize" section):
 *
 *   POST http://<connector>:<RADIUS_POLICY_PORT>/radius/authorize
 *   header  X-FibrePulse-Radius-Secret: <RADIUS_POLICY_SECRET>
 *           (or HTTP Basic auth with any user name and the secret as password,
 *            for FreeRADIUS versions that cannot send custom headers)
 *   body    {"username": "<User-Name>"}
 *
 *   200 {"reply:Mikrotik-Rate-Limit": "10M/10M"}   allowed, with speeds
 *   401 {"reply:Reply-Message": "..."}             refused (no live package)
 *   404                                             not a FibrePulse customer:
 *                                                   RADIUS decides on its own
 *
 * The list comes from FibrePulse on every sync and is kept on disk, so
 * customers keep connecting normally if the internet link to FibrePulse drops.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { RadiusEntry } from "./cloud.js";
import { log } from "./log.js";

export type Decision = { status: 200 | 401 | 404; body: Record<string, string> };

/** MikroTik rate limit "rx/tx" from the router's view: upload/download of the customer. */
export function rateLimit(e: Pick<RadiusEntry, "download_mbps" | "upload_mbps">): string | null {
  if (!e.download_mbps) return null;
  const up = e.upload_mbps || e.download_mbps;
  return `${up}M/${e.download_mbps}M`;
}

export class RadiusPolicy {
  private entries = new Map<string, RadiusEntry>();
  private updatedAt: string | null = null;

  constructor(private cacheFile: string | null = null) {
    if (cacheFile) {
      try {
        const saved = JSON.parse(readFileSync(cacheFile, "utf8")) as { updated_at: string; entries: RadiusEntry[] };
        this.load(saved.entries, saved.updated_at, false);
        log("info", "RADIUS policy loaded from cache", { customers: this.entries.size, updated_at: saved.updated_at });
      } catch {
        // no cache yet
      }
    }
  }

  get size() {
    return this.entries.size;
  }

  get lastUpdated() {
    return this.updatedAt;
  }

  load(list: RadiusEntry[], at = new Date().toISOString(), persist = true) {
    this.entries = new Map(list.filter((e) => e && typeof e.username === "string").map((e) => [e.username.toLowerCase(), e]));
    this.updatedAt = at;
    if (persist && this.cacheFile) {
      const tmp = `${this.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ updated_at: at, entries: list }), { mode: 0o600 });
      renameSync(tmp, this.cacheFile);
    }
  }

  decide(username: string): Decision {
    const e = this.entries.get(String(username ?? "").trim().toLowerCase());
    if (!e) return { status: 404, body: {} };
    if (!e.allowed) return { status: 401, body: { "reply:Reply-Message": "No active internet package. Please renew." } };
    const limit = rateLimit(e);
    return { status: 200, body: limit ? { "reply:Mikrotik-Rate-Limit": limit } : {} };
  }
}

/** The secret from the custom header, or the password of HTTP Basic auth. */
export function presentedSecret(req: Pick<IncomingMessage, "headers">): string | undefined {
  const header = req.headers["x-fibrepulse-radius-secret"];
  if (typeof header === "string") return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    return i >= 0 ? decoded.slice(i + 1) : undefined;
  }
  return undefined;
}

function sameSecret(given: string | undefined, expected: string) {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function radiusHandler(policy: RadiusPolicy, secret: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { customers: policy.size, updated_at: policy.lastUpdated });
    if (req.method !== "POST" || req.url !== "/radius/authorize") return send(404, { error: "Not found" });
    if (!sameSecret(presentedSecret(req), secret)) return send(403, { error: "Wrong secret" });
    let username = "";
    try {
      const body = await readBody(req);
      const parsed = (body ? JSON.parse(body) : {}) as { username?: unknown; "User-Name"?: unknown };
      username = String(parsed.username ?? parsed["User-Name"] ?? "");
    } catch {
      return send(400, { error: "Send JSON like {\"username\": \"...\"}" });
    }
    const d = policy.decide(username);
    if (d.status !== 200) log("info", "RADIUS policy refused", { username, status: d.status });
    return send(d.status, d.body);
  };
}

export function startRadiusServer(policy: RadiusPolicy, host: string, port: number, secret: string): Server {
  const server = createServer(radiusHandler(policy, secret));
  server.listen(port, host, () => log("info", "RADIUS policy endpoint listening", { host, port }));
  return server;
}
