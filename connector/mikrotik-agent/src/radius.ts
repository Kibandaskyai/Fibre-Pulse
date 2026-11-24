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
 *   body    {"username": "<User-Name>", "mac": "<Calling-Station-Id>"}
 *
 *   200 {"reply:Mikrotik-Rate-Limit": "10M/10M"}   allowed, with speeds
 *   401 {"reply:Reply-Message": "..."}             refused (no live package)
 *   404                                             not a FibrePulse customer:
 *                                                   RADIUS decides on its own
 *
 * Hotspot access codes (pilot client, 24 Nov 2026): the code is both the user
 * name and the password, so the answer also carries
 *   "control:Cleartext-Password": "<code>"   (lets RADIUS check PAP or CHAP)
 *   "reply:Session-Timeout": <seconds left>  (the router cuts them off at 0)
 * A code works on ONE device: the first device (MAC) that logs in owns it,
 * and any other device is refused. The clock starts at that first login.
 *
 * The list comes from FibrePulse (only when it changed) and is kept on disk
 * together with first-login times and devices learned here, so people keep
 * connecting normally, and nobody gets their time twice, if the internet link
 * to FibrePulse drops.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { RadiusEntry } from "./cloud.js";
import { log } from "./log.js";

export type Decision = { status: 200 | 401 | 404; body: Record<string, string | number> };

/** What this connector learned itself: first login time and device per code. */
type LocalUse = { activated_at: string; mac: string | null };

/** "AA-BB-CC-00-11-22", "aabb.cc00.1122" or "AA:BB:..." to "aa:bb:cc:00:11:22". */
export function normaliseMac(v: unknown): string | null {
  const hex = String(v ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex.match(/../g)!.join(":") : null;
}

/** MikroTik rate limit "rx/tx" from the router's view: upload/download of the customer. */
export function rateLimit(e: Pick<RadiusEntry, "download_mbps" | "upload_mbps">): string | null {
  if (!e.download_mbps) return null;
  const up = e.upload_mbps || e.download_mbps;
  return `${up}M/${e.download_mbps}M`;
}

export class RadiusPolicy {
  private entries = new Map<string, RadiusEntry>();
  private local = new Map<string, LocalUse>();
  private updatedAt: string | null = null;
  /** The version of the list held, sent back to FibrePulse on each sync. */
  version: string | null = null;

  constructor(private cacheFile: string | null = null, private now: () => number = Date.now) {
    if (cacheFile) {
      try {
        const saved = JSON.parse(readFileSync(cacheFile, "utf8")) as { updated_at: string; version?: string | null; entries: RadiusEntry[]; local?: Record<string, LocalUse> };
        this.local = new Map(Object.entries(saved.local ?? {}));
        this.load(saved.entries, saved.updated_at, false, saved.version ?? null);
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

  load(list: RadiusEntry[], at = new Date().toISOString(), persist = true, version: string | null = null) {
    this.entries = new Map(list.filter((e) => e && typeof e.username === "string").map((e) => [e.username.toLowerCase(), e]));
    this.updatedAt = at;
    this.version = version;
    // Forget local first logins for codes FibrePulse no longer lists, or now
    // knows about itself (it starts the clock when it sees the session).
    for (const [k] of this.local) {
      const e = this.entries.get(k);
      if (!e || (e.expires_at && e.mac)) this.local.delete(k);
    }
    if (persist) this.persist();
  }

  private persist() {
    if (!this.cacheFile) return;
    const tmp = `${this.cacheFile}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ updated_at: this.updatedAt, version: this.version, entries: [...this.entries.values()], local: Object.fromEntries(this.local) }),
      { mode: 0o600 },
    );
    renameSync(tmp, this.cacheFile);
  }

  decide(username: string, macAddress?: unknown): Decision {
    const key = String(username ?? "").trim().toLowerCase();
    const e = this.entries.get(key);
    if (!e) return { status: 404, body: {} };
    if (!e.allowed) return { status: 401, body: { "reply:Reply-Message": "No active internet package. Please renew." } };
    const now = this.now();
    if (e.kind !== "hotspot") {
      if (e.expires_at && Date.parse(e.expires_at) <= now) return { status: 401, body: { "reply:Reply-Message": "Your package has ended. Please renew." } };
      const limit = rateLimit(e);
      return { status: 200, body: limit ? { "reply:Mikrotik-Rate-Limit": limit } : {} };
    }

    // Hotspot access code: one device, clock from first login.
    const mac = normaliseMac(macAddress);
    const used = this.local.get(key);
    const owner = normaliseMac(e.mac) ?? used?.mac ?? null;
    if (owner && mac && owner !== mac) {
      return { status: 401, body: { "reply:Reply-Message": "This code is already in use on another device. Buy a code for this device." } };
    }
    let ends: number;
    if (e.expires_at) ends = Date.parse(e.expires_at);
    else if (used) ends = Date.parse(used.activated_at) + (e.duration_seconds ?? 0) * 1000;
    else {
      // First login: start the clock and remember the device.
      this.local.set(key, { activated_at: new Date(now).toISOString(), mac });
      this.persist();
      ends = now + (e.duration_seconds ?? 0) * 1000;
    }
    const left = Math.floor((ends - now) / 1000);
    if (!(left > 0)) return { status: 401, body: { "reply:Reply-Message": "Your time has ended. Buy a new plan to continue." } };
    if (!owner && mac && used && !used.mac) {
      used.mac = mac;
      this.persist();
    }
    const limit = rateLimit(e);
    return {
      status: 200,
      body: {
        "control:Cleartext-Password": e.username,
        "reply:Session-Timeout": left,
        ...(limit ? { "reply:Mikrotik-Rate-Limit": limit } : {}),
      },
    };
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
    let mac: unknown;
    try {
      const body = await readBody(req);
      const parsed = (body ? JSON.parse(body) : {}) as { username?: unknown; "User-Name"?: unknown; mac?: unknown; "Calling-Station-Id"?: unknown };
      username = String(parsed.username ?? parsed["User-Name"] ?? "");
      mac = parsed.mac ?? parsed["Calling-Station-Id"];
    } catch {
      return send(400, { error: "Send JSON like {\"username\": \"...\"}" });
    }
    const d = policy.decide(username, mac);
    if (d.status !== 200) log("info", "RADIUS policy refused", { username, status: d.status });
    return send(d.status, d.body);
  };
}

export function startRadiusServer(policy: RadiusPolicy, host: string, port: number, secret: string): Server {
  const server = createServer(radiusHandler(policy, secret));
  server.listen(port, host, () => log("info", "RADIUS policy endpoint listening", { host, port }));
  return server;
}
