/**
 * RADIUS mode: the policy the connector serves to the ISP's FreeRADIUS, its
 * local HTTP endpoint, the on-disk cache, and RADIUS-mode disconnects.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../connector/mikrotik-agent/src/config";
import { runCommand } from "../../connector/mikrotik-agent/src/commands";
import { radiusHandler, RadiusPolicy, rateLimit } from "../../connector/mikrotik-agent/src/radius";
import { RouterOsClient } from "../../connector/mikrotik-agent/src/routeros";

const SECRET = "radius-shared-secret-0123456789";
const list = [
  { username: "grace.w", allowed: true, download_mbps: 20, upload_mbps: 20, expires_at: "2099-12-24T00:00:00Z" },
  { username: "Peter.N", allowed: false, download_mbps: null, upload_mbps: null, expires_at: null },
];

describe("RADIUS policy", () => {
  it("allows live packages with MikroTik speeds, refuses lapsed ones, ignores strangers", () => {
    const p = new RadiusPolicy();
    p.load(list);
    expect(p.decide("grace.w")).toEqual({ status: 200, body: { "reply:Mikrotik-Rate-Limit": "20M/20M" } });
    expect(p.decide("peter.n").status).toBe(401);
    expect(p.decide("staff-laptop").status).toBe(404);
    expect(rateLimit({ download_mbps: 40, upload_mbps: 10 })).toBe("10M/40M");
    expect(rateLimit({ download_mbps: null, upload_mbps: null })).toBeNull();
  });

  it("keeps the last list on disk for when FibrePulse is unreachable", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fp-radius-")), "radius.json");
    new RadiusPolicy(file).load(list);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(2);
    const restarted = new RadiusPolicy(file);
    expect(restarted.size).toBe(2);
    expect(restarted.decide("grace.w").status).toBe(200);
  });

  it("needs a long shared secret when the endpoint is on", () => {
    const base = { FIBREPULSE_URL: "http://localhost:3000", FIBREPULSE_TOKEN: "fpc_" + "a1".repeat(24) };
    expect(loadConfig(base).radiusPort).toBe(0);
    expect(() => loadConfig({ ...base, RADIUS_POLICY_PORT: "18120", RADIUS_POLICY_SECRET: "short" })).toThrow(/24 characters/);
    expect(loadConfig({ ...base, RADIUS_POLICY_PORT: "18120", RADIUS_POLICY_SECRET: SECRET }).radiusPort).toBe(18120);
  });
});

describe("RADIUS policy endpoint", () => {
  const policy = new RadiusPolicy();
  policy.load(list);
  const server = http.createServer(radiusHandler(policy, SECRET));
  let url = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const ask = (username: string, secret = SECRET) =>
    fetch(`${url}/radius/authorize`, { method: "POST", headers: { "x-fibrepulse-radius-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ username }) });

  it("answers FreeRADIUS rlm_rest with the right status codes", async () => {
    const ok = await ask("grace.w");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ "reply:Mikrotik-Rate-Limit": "20M/20M" });
    expect((await ask("peter.n")).status).toBe(401);
    expect((await ask("unknown")).status).toBe(404);
  });

  it("accepts the secret as an HTTP Basic password too", async () => {
    const res = await fetch(`${url}/radius/authorize`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`freeradius:${SECRET}`).toString("base64") },
      body: JSON.stringify({ username: "grace.w" }),
    });
    expect(res.status).toBe(200);
  });

  it("refuses a wrong secret and reports health", async () => {
    expect((await ask("grace.w", "wrong")).status).toBe(403);
    const health = await (await fetch(`${url}/health`)).json();
    expect(health.customers).toBe(2);
  });
});

describe("RADIUS-mode router commands", () => {
  const calls: string[] = [];
  const router = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/rest/ppp/active?name=grace.w") return res.end(JSON.stringify([{ ".id": "*A1", name: "grace.w" }]));
    if (req.url === "/rest/ppp/active?name=away") return res.end("[]");
    if (req.url === "/rest/ppp/active/*A1" && req.method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end("{}");
  });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
    port = (router.address() as AddressInfo).port;
  });
  afterAll(() => router.close());
  const client = () => new RouterOsClient({ address: "127.0.0.1", port, scheme: "http", verifyTls: false, username: "u", password: "p", timeoutMs: 2000 });

  it("drops only the live session and never touches PPPoE secrets", async () => {
    expect(await runCommand(client(), "disconnect_pppoe", "grace.w", "radius")).toMatch(/Removed 1 active session/);
    expect(await runCommand(client(), "disconnect_pppoe", "away", "radius")).toMatch(/was not online/);
    expect(await runCommand(client(), "reconnect_pppoe", "grace.w", "radius")).toMatch(/RADIUS will accept/);
    expect(calls.some((c) => c.includes("/ppp/secret"))).toBe(false);
    expect(calls).toContain("DELETE /rest/ppp/active/*A1");
  });
});
