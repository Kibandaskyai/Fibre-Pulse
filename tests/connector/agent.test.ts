/**
 * The connector agent against a fake RouterOS REST server and a fake
 * FibrePulse cloud that checks signatures with the app's own code.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifySignature, sign as appSign } from "@/lib/connector/signature";
import { Agent } from "../../connector/mikrotik-agent/src/agent";
import { loadConfig } from "../../connector/mikrotik-agent/src/config";
import { runCommand } from "../../connector/mikrotik-agent/src/commands";
import { pollRouter, rate } from "../../connector/mikrotik-agent/src/poller";
import { parseDuration, RouterOsClient } from "../../connector/mikrotik-agent/src/routeros";
import { sign as agentSign } from "../../connector/mikrotik-agent/src/signature";

// ---------------------------------------------------------------- fake router
type Call = { method: string; path: string; body: string };
const routerCalls: Call[] = [];
let rxBytes = 1_000_000;
let pppDisabled = false;
let resourceFails = false;
const router = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    routerCalls.push({ method: req.method!, path: req.url!, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== "Basic " + Buffer.from("fibrepulse-ro:s3cret").toString("base64")) return send(401, { error: 401, message: "Unauthorized" });
    const url = req.url!;
    if (url === "/rest/system/resource") {
      if (resourceFails) return req.socket.destroy();
      return send(200, { uptime: "1w2d3h4m5s", "cpu-load": "17", "free-memory": "268435456", "total-memory": "1073741824", "board-name": "hEX S", version: "7.16.1 (stable)" });
    }
    if (url === "/rest/system/identity") return send(200, { name: "ruiru-core" });
    if (url === "/rest/system/routerboard") return send(200, { model: "RB760iGS", "serial-number": "HF1234" });
    if (url === "/rest/interface") {
      rxBytes += 7_500_000;
      return send(200, [
        { ".id": "*1", name: "ether1", type: "ether", "mac-address": "48:A9:8A:00:00:01", running: "true", disabled: "false", "rx-byte": String(rxBytes), "tx-byte": "500" },
        { ".id": "*2", name: "ether2", type: "ether", running: "false", disabled: "false", "rx-byte": "0", "tx-byte": "0" },
      ]);
    }
    if (url === "/rest/ppp/active") return send(200, [{ ".id": "*A1", name: "grace.w", service: "pppoe", address: "10.0.0.5", "caller-id": "AA:BB:CC:DD:EE:FF", uptime: "2h3m" }]);
    if (url === "/rest/ip/hotspot/active") return send(404, { error: 404, message: "Not Found", detail: "no such command" });
    if (url === "/rest/ppp/secret?name=grace.w") return send(200, [{ ".id": "*S9", name: "grace.w", disabled: String(pppDisabled) }]);
    if (url === "/rest/ppp/secret?name=nobody") return send(200, []);
    if (url === "/rest/ppp/secret/*S9" && req.method === "PATCH") {
      pppDisabled = JSON.parse(body).disabled === "true";
      return send(200, {});
    }
    if (url === "/rest/ppp/active?name=grace.w") return send(200, pppDisabled ? [{ ".id": "*A1", name: "grace.w" }] : []);
    if (url === "/rest/ppp/active/*A1" && req.method === "DELETE") return send(204, null);
    send(404, { error: 404, message: "Not Found" });
  });
});

// ----------------------------------------------------------------- fake cloud
const TOKEN = "fpc_" + "a1".repeat(24);
const cloudCalls: { path: string; body: Record<string, unknown>; signed: boolean }[] = [];
let cloudDown = false;
let routerPort = 0;
const commands: unknown[] = [];
const cloud = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const h = req.headers;
    const signed =
      h.authorization === `Bearer ${TOKEN}` &&
      verifySignature(TOKEN, String(h["x-fibrepulse-signature"]), String(h["x-fibrepulse-timestamp"]), String(h["x-fibrepulse-nonce"]), req.method!, req.url!, body);
    cloudCalls.push({ path: req.url!, body: JSON.parse(body || "{}"), signed });
    res.setHeader("content-type", "application/json");
    if (cloudDown) {
      res.writeHead(503);
      return res.end(JSON.stringify({ error: "down" }));
    }
    if (req.url === "/api/connector/v1/sync") {
      return res.end(JSON.stringify({
        agent_id: "agent-1", tenant_id: "t-1", poll_interval_seconds: 60, router_enforcement: true,
        routers: [
          { id: "r-real", name: "Core", address: "127.0.0.1", port: routerPort, scheme: "http", verify_tls: false, simulated: false, username: "fibrepulse-ro", password: "s3cret", credential_error: null },
          { id: "r-nocreds", name: "Edge", address: "127.0.0.1", port: routerPort, scheme: "http", verify_tls: false, simulated: false, username: null, password: null, credential_error: null },
          { id: "r-sim", name: "Sim Router", address: null, port: null, scheme: "https", verify_tls: false, simulated: true, username: null, password: null, credential_error: null },
        ],
        commands: commands.splice(0),
      }));
    }
    if (req.url === "/api/connector/v1/ingest") return res.end(JSON.stringify({ accepted: 1, rejected: [] }));
    if (req.url === "/api/connector/v1/commands") return res.end(JSON.stringify({ ok: true }));
    res.writeHead(404);
    res.end("{}");
  });
});

let cloudUrl = "";
beforeAll(async () => {
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
  routerPort = (router.address() as AddressInfo).port;
  cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
});
afterAll(() => {
  router.close();
  cloud.close();
});

const client = () => new RouterOsClient({ address: "127.0.0.1", port: routerPort, scheme: "http", verifyTls: false, username: "fibrepulse-ro", password: "s3cret", timeoutMs: 2000 });
const cfg = (over: Record<string, string> = {}) => loadConfig({ FIBREPULSE_URL: cloudUrl, FIBREPULSE_TOKEN: TOKEN, ...over });

describe("RouterOS parsing", () => {
  it("reads RouterOS durations", () => {
    expect(parseDuration("1w2d3h4m5s")).toBe(604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseDuration("2h3m")).toBe(7380);
    expect(parseDuration("45s500ms")).toBe(45);
    expect(parseDuration("00:10:05")).toBe(605);
    expect(parseDuration("")).toBeNull();
  });

  it("computes traffic rates and ignores counter resets", () => {
    expect(rate(1000, 2000, 1)).toBe(8000);
    expect(rate(undefined, 2000, 1)).toBeNull();
    expect(rate(5000, 100, 10)).toBeNull();
  });
});

describe("pollRouter", () => {
  it("turns RouterOS answers into a reading with rates from the second poll", async () => {
    const counters = new Map();
    let t = 1_000_000;
    const first = await pollRouter("r1", client(), counters, () => t);
    expect(first).toMatchObject({
      reachable: true,
      system: { identity: "ruiru-core", model: "RB760iGS", serial_number: "HF1234", version: "7.16.1 (stable)", uptime_seconds: 788645, cpu_load_pct: 17, memory_used_pct: 75 },
      sessions: [{ type: "pppoe", username: "grace.w", address: "10.0.0.5", caller_id: "AA:BB:CC:DD:EE:FF", uptime_seconds: 7380 }],
    });
    expect(first.interfaces?.[0]).toMatchObject({ name: "ether1", running: true, rx_bps: null });
    t += 60_000;
    const second = await pollRouter("r1", client(), counters, () => t);
    expect(second.interfaces?.[0].rx_bps).toBe(1_000_000); // 7.5 MB in 60 s
    expect(second.warnings).toBeUndefined(); // hotspot 404 is not a warning
  });

  it("reports an unreachable router without throwing", async () => {
    resourceFails = true;
    const r = await pollRouter("r1", client(), new Map());
    resourceFails = false;
    expect(r.reachable).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("reports wrong credentials clearly", async () => {
    const bad = new RouterOsClient({ address: "127.0.0.1", port: routerPort, scheme: "http", verifyTls: false, username: "x", password: "y", timeoutMs: 2000 });
    const r = await pollRouter("r1", bad, new Map());
    expect(r).toMatchObject({ reachable: false, error: "Router refused the API username or password." });
  });
});

describe("router commands", () => {
  it("disables the PPPoE secret and removes the active session, then re-enables it", async () => {
    routerCalls.length = 0;
    expect(await runCommand(client(), "disconnect_pppoe", "grace.w")).toBe("PPPoE secret grace.w disabled and 1 active session removed.");
    expect(routerCalls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path} ${c.body}`)).toEqual([
      'PATCH /rest/ppp/secret/*S9 {"disabled":"true"}',
      "DELETE /rest/ppp/active/*A1 ",
    ]);
    expect(await runCommand(client(), "reconnect_pppoe", "grace.w")).toMatch(/enabled/);
    expect(pppDisabled).toBe(false);
  });

  it("refuses unknown secrets and odd usernames", async () => {
    await expect(runCommand(client(), "disconnect_pppoe", "nobody")).rejects.toThrow(/was not found/);
    await expect(runCommand(client(), "disconnect_pppoe", "a b;/system/reboot")).rejects.toThrow(/characters/);
  });
});

describe("Agent", () => {
  it("signs requests exactly like the app", () => {
    const args = ["2026-11-23T20:00:00.000Z", "abcdef0123456789", "POST", "/api/connector/v1/ingest", '{"routers":[]}'] as const;
    expect(agentSign(TOKEN, ...args)).toBe(appSign(TOKEN, ...args));
  });

  it("refuses insecure or missing settings", () => {
    expect(() => loadConfig({ FIBREPULSE_URL: "http://fibrepulse.example", FIBREPULSE_TOKEN: TOKEN })).toThrow(/https/);
    expect(() => loadConfig({ FIBREPULSE_URL: "https://fibrepulse.example", FIBREPULSE_TOKEN: "abc" })).toThrow(/TOKEN/);
  });

  it("syncs, polls real routers only, and sends one signed batch", async () => {
    cloudCalls.length = 0;
    const agent = new Agent(cfg());
    await agent.runOnce();
    expect(cloudCalls.every((c) => c.signed)).toBe(true);
    const ingest = cloudCalls.find((c) => c.path === "/api/connector/v1/ingest")!;
    const readings = ingest.body.routers as { router_id: string; reachable: boolean; skipped?: boolean; error?: string }[];
    expect(readings.map((r) => r.router_id)).toEqual(["r-real", "r-nocreds"]);
    expect(readings[0].reachable).toBe(true);
    expect(readings[1]).toMatchObject({ reachable: false, skipped: true });
    expect(ingest.body.simulated).toBeUndefined();
  });

  it("in simulate mode reports only simulated routers, flagged as simulated", async () => {
    cloudCalls.length = 0;
    await new Agent(cfg({ SIMULATE: "true" })).runOnce();
    const ingest = cloudCalls.find((c) => c.path === "/api/connector/v1/ingest")!;
    expect(ingest.body.simulated).toBe(true);
    expect((ingest.body.routers as { router_id: string }[]).map((r) => r.router_id)).toEqual(["r-sim"]);
  });

  it("refuses router commands unless writes are allowed on the connector", async () => {
    cloudCalls.length = 0;
    routerCalls.length = 0;
    commands.push({ id: "c-1", router_id: "r-real", type: "disconnect_pppoe", pppoe_username: "grace.w" });
    await new Agent(cfg()).sync();
    expect(routerCalls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(cloudCalls.find((c) => c.path === "/api/connector/v1/commands")?.body).toMatchObject({ command_id: "c-1", success: false, message: expect.stringMatching(/ALLOW_ROUTER_WRITES/) });

    cloudCalls.length = 0;
    commands.push({ id: "c-2", router_id: "r-real", type: "disconnect_pppoe", pppoe_username: "grace.w" });
    await new Agent(cfg({ ALLOW_ROUTER_WRITES: "true" })).sync();
    expect(cloudCalls.find((c) => c.path === "/api/connector/v1/commands")?.body).toMatchObject({ command_id: "c-2", success: true });
    expect(pppDisabled).toBe(true);
    await runCommand(client(), "reconnect_pppoe", "grace.w");
  });

  it("keeps readings while FibrePulse is down and sends them, oldest first, when it is back", async () => {
    const agent = new Agent(cfg());
    await agent.sync();
    cloudDown = true;
    await agent.report(await agent.pollAll());
    await agent.report(await agent.pollAll());
    expect(agent.backoffMs()).toBeGreaterThan(0);
    cloudDown = false;
    cloudCalls.length = 0;
    await agent.report([]);
    const sent = cloudCalls.filter((c) => c.path === "/api/connector/v1/ingest");
    expect(sent).toHaveLength(2);
    const times = sent.map((c) => (c.body.routers as { collected_at: string }[])[0].collected_at);
    expect(times[0] <= times[1]).toBe(true);
  });
});
