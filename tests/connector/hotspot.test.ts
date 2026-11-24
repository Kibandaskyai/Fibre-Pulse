/**
 * Pilot client update (24 Nov 2026): hotspot access codes in the RADIUS
 * policy (one device per code, clock from first login), the hotspot
 * disconnect command, the upstream (Safaricom) check and the simulator.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../../connector/mikrotik-agent/src/commands";
import { checkUpstream, parseRtt } from "../../connector/mikrotik-agent/src/poller";
import { normaliseMac, RadiusPolicy } from "../../connector/mikrotik-agent/src/radius";
import { RouterOsClient } from "../../connector/mikrotik-agent/src/routeros";
import { simulateReading } from "../../connector/mikrotik-agent/src/simulator";

const T0 = Date.parse("2026-11-24T10:00:00Z");
const code = (over: Record<string, unknown> = {}) => ({
  username: "K7PX2M",
  kind: "hotspot" as const,
  allowed: true,
  download_mbps: 10,
  upload_mbps: 10,
  expires_at: null,
  duration_seconds: 3600,
  mac: null,
  ...over,
});

describe("hotspot codes in the RADIUS policy", () => {
  it("starts the clock at first login, ties the code to that device and refuses any other device", () => {
    let now = T0;
    const p = new RadiusPolicy(null, () => now);
    p.load([code()]);
    expect(p.decide("k7px2m", "AA-BB-CC-00-11-22")).toEqual({
      status: 200,
      body: { "control:Cleartext-Password": "K7PX2M", "reply:Session-Timeout": 3600, "reply:Mikrotik-Rate-Limit": "10M/10M" },
    });
    now += 20 * 60 * 1000;
    expect(p.decide("K7PX2M", "aa:bb:cc:00:11:22").body["reply:Session-Timeout"]).toBe(2400);
    const other = p.decide("K7PX2M", "AA:BB:CC:99:99:99");
    expect(other.status).toBe(401);
    expect(other.body["reply:Reply-Message"]).toMatch(/another device/);
    now += 41 * 60 * 1000;
    expect(p.decide("K7PX2M", "aa:bb:cc:00:11:22")).toMatchObject({ status: 401, body: { "reply:Reply-Message": expect.stringMatching(/time has ended/) } });
  });

  it("uses FibrePulse's expiry and device once it knows them", () => {
    const now = T0;
    const p = new RadiusPolicy(null, () => now);
    p.load([code({ expires_at: new Date(T0 + 90_000).toISOString(), mac: "AA:BB:CC:00:11:22" })]);
    expect(p.decide("K7PX2M", "AA:BB:CC:00:11:22").body["reply:Session-Timeout"]).toBe(90);
    expect(p.decide("K7PX2M", "AA:BB:CC:00:11:23").status).toBe(401);
    // Monthly (PPPoE) customers whose package has ended are refused too.
    p.load([{ username: "grace.w", allowed: true, download_mbps: 20, upload_mbps: 20, expires_at: new Date(T0 - 1000).toISOString() }]);
    expect(p.decide("grace.w").status).toBe(401);
  });

  it("remembers first logins across a restart, so nobody gets their time twice while FibrePulse is unreachable", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fp-hs-")), "radius.json");
    let now = T0;
    const p = new RadiusPolicy(file, () => now);
    p.load([code()], undefined, true, "v1");
    p.decide("K7PX2M", "AA:BB:CC:00:11:22");
    now += 50 * 60 * 1000;
    const restarted = new RadiusPolicy(file, () => now);
    expect(restarted.version).toBe("v1");
    expect(restarted.decide("K7PX2M", "AA:BB:CC:00:11:22").body["reply:Session-Timeout"]).toBe(600);
    expect(restarted.decide("K7PX2M", "AA:BB:CC:00:11:99").status).toBe(401);
  });

  it("gives Limited codes their data left and refuses a code whose data is used up", () => {
    const p = new RadiusPolicy(null, () => T0);
    const big = 5 * 2 ** 32 + 123; // over 4 GiB: needs the Gigawords attribute
    p.load([
      code({ expires_at: "2026-11-24T13:00:00Z", data_left_bytes: big }),
      code({ username: "EMPTY1", expires_at: "2026-11-24T13:00:00Z", data_left_bytes: 0 }),
    ]);
    const ok = p.decide("K7PX2M", "aa:bb:cc:00:11:22");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ "reply:Mikrotik-Total-Limit": 123, "reply:Mikrotik-Total-Limit-Gigawords": 5, "reply:Session-Timeout": 3 * 3600 });
    expect(p.decide("EMPTY1", "aa:bb:cc:00:11:23")).toEqual({ status: 401, body: { "reply:Reply-Message": "Your data is used up. Buy a new plan to continue." } });
  });

  it("reads MAC addresses in the usual RADIUS spellings", () => {
    expect(normaliseMac("AA-BB-CC-00-11-22")).toBe("aa:bb:cc:00:11:22");
    expect(normaliseMac("aabb.cc00.1122")).toBe("aa:bb:cc:00:11:22");
    expect(normaliseMac("nope")).toBeNull();
  });
});

describe("router calls", () => {
  const calls: string[] = [];
  let pingReply: unknown = [];
  const router = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url} ${body}`);
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(data === null ? "" : JSON.stringify(data));
      };
      if (req.url === "/rest/ip/hotspot/active?user=K7PX2M") return send(200, [{ ".id": "*H1", user: "K7PX2M", "mac-address": "AA:BB:CC:00:11:22" }]);
      if (req.url === "/rest/ip/hotspot/cookie?user=K7PX2M") return send(200, [{ ".id": "*C1", user: "K7PX2M" }]);
      if (req.url === "/rest/ip/hotspot/active?user=GONE99" || req.url === "/rest/ip/hotspot/cookie?user=GONE99") return send(200, []);
      if (req.method === "DELETE") return send(204, null);
      if (req.url === "/rest/ping") return send(200, pingReply);
      send(404, { message: "no such command" });
    });
  });
  let client: RouterOsClient;
  beforeAll(async () => {
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
    client = new RouterOsClient({ address: "127.0.0.1", port: (router.address() as AddressInfo).port, scheme: "http", verifyTls: false, username: "u", password: "p", timeoutMs: 2000 });
  });
  afterAll(() => router.close());

  it("disconnects a hotspot code: removes its session and its login cookie", async () => {
    calls.length = 0;
    const msg = await runCommand(client, "disconnect_hotspot", "K7PX2M", "radius");
    expect(msg).toBe("Removed 1 hotspot session for code K7PX2M.");
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /rest/ip/hotspot/active/*H1 ", "DELETE /rest/ip/hotspot/cookie/*C1 "]);
    expect(await runCommand(client, "disconnect_hotspot", "GONE99", "radius")).toBe("Code GONE99 was not online.");
  });

  it("checks the internet by pinging from the router", async () => {
    pingReply = [
      { seq: "0", host: "8.8.8.8", time: "18ms", sent: "1", received: "1", "packet-loss": "0" },
      { seq: "2", host: "8.8.8.8", time: "20ms", sent: "3", received: "3", "packet-loss": "0", "avg-rtt": "19ms500us" },
    ];
    expect(await checkUpstream(client, "8.8.8.8")).toEqual({ target: "8.8.8.8", reachable: true, loss_pct: 0, avg_ms: 19.5 });
    expect(calls.at(-1)).toBe('POST /rest/ping {"address":"8.8.8.8","count":"3","interval":"0.2"}');
    pingReply = [{ seq: "2", host: "8.8.8.8", status: "timeout", sent: "3", received: "0", "packet-loss": "100" }];
    expect(await checkUpstream(client, "8.8.8.8")).toEqual({ target: "8.8.8.8", reachable: false, loss_pct: 100, avg_ms: null });
    expect(parseRtt("1s20ms")).toBe(1020);
    expect(parseRtt(undefined)).toBeNull();
  });
});

describe("simulator", () => {
  it("adds hotspot users and an upstream check, and can simulate a Safaricom outage", () => {
    const ok = simulateReading("r1", "Ruiru", T0);
    expect(ok.sessions!.filter((s) => s.type === "hotspot").length).toBeGreaterThan(30);
    expect(ok.upstream).toMatchObject({ reachable: true });
    expect(simulateReading("r1", "Ruiru", T0, { upstreamDown: true }).upstream).toMatchObject({ reachable: false, loss_pct: 100 });
  });
});
