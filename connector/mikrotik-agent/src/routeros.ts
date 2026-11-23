/**
 * Minimal MikroTik RouterOS v7 REST client (https://help.mikrotik.com/docs/display/ROS/REST+API).
 * Uses node:https so a router's self-signed certificate can be accepted when
 * verify_tls is off (the default on new RouterOS installs). Runs only inside
 * the ISP network; router ports are never exposed to the internet.
 */
import http from "node:http";
import https from "node:https";

export class RouterOsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type RouterOsTarget = {
  address: string;
  port?: number | null;
  scheme: "https" | "http";
  verifyTls: boolean;
  username: string;
  password: string;
  timeoutMs: number;
};

export type Row = Record<string, string | undefined>;

export class RouterOsClient {
  constructor(private t: RouterOsTarget) {}

  request<T = unknown>(method: "GET" | "PATCH" | "DELETE" | "POST", path: string, body?: unknown): Promise<T> {
    const lib = this.t.scheme === "https" ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = lib.request(
        {
          host: this.t.address,
          port: this.t.port ?? (this.t.scheme === "https" ? 443 : 80),
          method,
          path: `/rest${path}`,
          rejectUnauthorized: this.t.verifyTls,
          timeout: this.t.timeoutMs,
          headers: {
            authorization: "Basic " + Buffer.from(`${this.t.username}:${this.t.password}`).toString("base64"),
            accept: "application/json",
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 20 * 1024 * 1024) req.destroy(new Error("Router response too large"));
            else chunks.push(c);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              json = null;
            }
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              const e = json as { message?: string; detail?: string } | null;
              const msg = status === 401 ? "Router refused the API username or password." : [e?.message, e?.detail].filter(Boolean).join(": ") || `HTTP ${status}`;
              reject(new RouterOsError(status, msg));
            } else resolve(json as T);
          });
        },
      );
      req.on("timeout", () => req.destroy(new RouterOsError(0, `No answer from ${this.t.address} within ${Math.round(this.t.timeoutMs / 1000)}s`)));
      req.on("error", (e) => reject(e instanceof RouterOsError ? e : new RouterOsError(0, (e as NodeJS.ErrnoException).code ? `${(e as NodeJS.ErrnoException).code} ${this.t.address}` : e.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(path: string) {
    return this.request<Row[] | Row>("GET", path);
  }
}

/** "1w2d3h4m5s" (RouterOS durations) to seconds. Also accepts "00:10:05". */
export function parseDuration(v: string | undefined): number | null {
  if (!v) return null;
  const clock = v.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (clock) return +clock[1] * 3600 + +clock[2] * 60 + +clock[3];
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let matched = false;
  for (const [, n, u] of v.matchAll(/(\d+)(w|d|h|m(?!s)|s)/g)) {
    total += Number(n) * units[u];
    matched = true;
  }
  return matched ? total : null;
}

export const num = (v: string | undefined): number | null => (v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
export const bool = (v: string | undefined): boolean | null => (v === "true" ? true : v === "false" ? false : null);
