/**
 * Phase 4 connector and network functions. The connector calls the public
 * functions as `anon` with its own token, exactly as the API routes do.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, asUserCommit, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";

let owner: TestUser;
let netAdmin: TestUser;
let support: TestUser;
let otherOwner: TestUser;
let tenant: string;
let otherTenant: string;
let agent: string;
let otherAgent: string;
let router: string;
let simRouter: string;
let customer: string;
let subscription: string;
const token = `fpc_${randomBytes(24).toString("hex")}`;
const otherToken = `fpc_${randomBytes(24).toString("hex")}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const nonce = () => randomBytes(12).toString("hex");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}

const sync = (c: pg.PoolClient, t = token, ts = new Date(), n = nonce()) =>
  c.query(`select public.connector_sync($1, $2, $3, 'test-1.0') as r`, [t, n, ts]).then((r) => r.rows[0].r);

const ingest = (c: pg.PoolClient, payload: unknown, t = token) =>
  c.query(`select public.connector_ingest($1, $2, now(), $3::jsonb) as r`, [t, nonce(), JSON.stringify(payload)]).then((r) => r.rows[0].r);

const reading = (over: Record<string, unknown> = {}) => ({
  router_id: router,
  collected_at: new Date().toISOString(),
  reachable: true,
  system: { identity: "core-ruiru", model: "CCR2004-1G-12S+2XS", serial_number: "HFX0123", version: "7.16.1", uptime_seconds: 86400, cpu_load_pct: 23, memory_used_pct: 41 },
  interfaces: [
    { name: "sfp-sfpplus1", type: "ether", mac_address: "48:A9:8A:00:00:01", running: true, disabled: false, rx_bps: 250_000_000, tx_bps: 40_000_000 },
    { name: "ether2", type: "ether", mac_address: "not-a-mac", running: false, disabled: false, rx_bps: 0, tx_bps: 0 },
  ],
  sessions: [
    { type: "pppoe", username: `grace.${runId}`, address: "10.10.0.5", caller_id: "48:A9:8A:11:22:33", uptime_seconds: 3600, bytes_in: 1000, bytes_out: 2000 },
    { type: "pppoe", username: "unknown.user", address: "bad-ip", uptime_seconds: 60 },
  ],
  ...over,
});

beforeAll(async () => {
  owner = await createUser("net-owner");
  netAdmin = await createUser("net-admin");
  support = await createUser("net-support");
  otherOwner = await createUser("net-other");
  tenant = await asUserCommit(owner, (c) => c.query(`select public.register_tenant('Network ISP', $1) as id`, [`net-${runId}`]).then((r) => r.rows[0].id));
  otherTenant = await asUserCommit(otherOwner, (c) => c.query(`select public.register_tenant('Other Net ISP', $1) as id`, [`neto-${runId}`]).then((r) => r.rows[0].id));
  await q(`update tenants set status = 'active' where id = any($1)`, [[tenant, otherTenant]]);
  await q(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'network_admin'), ($1, $3, 'support_agent')`, [tenant, netAdmin.id, support.id]);

  [{ id: agent }] = await q<{ id: string }>(
    `insert into connector_agents (tenant_id, name, token_hash, token_prefix) values ($1, 'Ruiru NOC', $2, 'fpc_test') returning id`,
    [tenant, hash(token)],
  );
  [{ id: otherAgent }] = await q<{ id: string }>(
    `insert into connector_agents (tenant_id, name, token_hash, token_prefix) values ($1, 'Other', $2, 'fpc_oth') returning id`,
    [otherTenant, hash(otherToken)],
  );
  [{ id: router }] = await q<{ id: string }>(
    `insert into routers (tenant_id, connector_agent_id, name, management_address, api_port, data_source) values ($1, $2, 'Core Ruiru', '192.168.88.1', 443, 'manual') returning id`,
    [tenant, agent],
  );
  [{ id: simRouter }] = await q<{ id: string }>(
    `insert into routers (tenant_id, connector_agent_id, name, data_source) values ($1, $2, 'Sim Router', 'simulated') returning id`,
    [tenant, agent],
  );
  await q(`insert into router_credentials (router_id, tenant_id, username, secret_ciphertext) values ($1, $2, 'fibrepulse-ro', 'v1:aaaa:bbbb:cccc')`, [router, tenant]);
  [{ id: customer }] = await q<{ id: string }>(
    `insert into customers (tenant_id, full_name, phone, status, pppoe_username) values ($1, 'Grace Network', '+254711000301', 'active', $2) returning id`,
    [tenant, `grace.${runId}`],
  );
  const [pkg] = await q<{ id: string }>(
    `insert into service_packages (tenant_id, name, download_mbps, upload_mbps, price, billing_period) values ($1, 'Lite', 10, 10, 1500, 'monthly') returning id`,
    [tenant],
  );
  [{ id: subscription }] = await q<{ id: string }>(
    `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period)
     values ($1, $2, $3, 'active', now() - interval '5 days', now() + interval '25 days', 1500, 'monthly') returning id`,
    [tenant, customer, pkg.id],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("connector authentication", () => {
  it("refuses unknown tokens, stale clocks and replayed nonces", async () => {
    await asUser(null, async (c) => {
      expect((await tryQuery(c, `select public.connector_sync($1, $2, now())`, ["fpc_" + "x".repeat(40), nonce()])).ok).toBe(false);
      const old = await tryQuery(c, `select public.connector_sync($1, $2, now() - interval '10 minutes')`, [token, nonce()]);
      expect(old.ok === false && old.error).toMatch(/5 minutes/);
      const n = nonce();
      expect((await tryQuery(c, `select public.connector_sync($1, $2, now())`, [token, n])).ok).toBe(true);
      const replay = await tryQuery(c, `select public.connector_sync($1, $2, now())`, [token, n]);
      expect(replay.ok === false && replay.error).toMatch(/replay/);
    });
  });

  it("refuses a revoked connector and a connector of an ISP that is not active", async () => {
    await asUser(null, async (c) => {
      await c.query("reset role");
      await c.query(`update connector_agents set status = 'revoked' where id = $1`, [otherAgent]);
      await c.query("set local role anon");
      expect((await tryQuery(c, `select public.connector_sync($1, $2, now())`, [otherToken, nonce()])).ok).toBe(false);
    });
  });

  it("returns only its own routers, with encrypted credentials, and marks itself active", async () => {
    await asUser(null, async (c) => {
      const r = await sync(c);
      expect(r.agent_id).toBe(agent);
      expect(r.routers.map((x: { id: string }) => x.id).sort()).toEqual([router, simRouter].sort());
      const core = r.routers.find((x: { id: string }) => x.id === router);
      expect(core).toMatchObject({ address: "192.168.88.1", port: 443, scheme: "https", verify_tls: false, username: "fibrepulse-ro", secret: "v1:aaaa:bbbb:cccc", simulated: false });
      expect(r.commands).toEqual([]);
      await c.query("reset role");
      const a = await c.query(`select status, agent_version from connector_agents where id = $1`, [agent]);
      expect(a.rows[0]).toEqual({ status: "active", agent_version: "test-1.0" });
    });
  });

  it("rate limits a connector that calls too often", async () => {
    await asUser(null, async (c) => {
      await c.query("reset role");
      await c.query(`insert into private.connector_nonces (agent_id, nonce) select $1, md5(g::text || $2) from generate_series(1, 120) g`, [agent, runId]);
      await c.query("set local role anon");
      const r = await tryQuery(c, `select public.connector_sync($1, $2, now())`, [token, nonce()]);
      expect(r.ok === false && r.error).toMatch(/Too many requests/);
    });
  });
});

describe("connector_ingest", () => {
  it("stores router health, interfaces and sessions, and links customers", async () => {
    await asUser(null, async (c) => {
      const r = await ingest(c, { routers: [reading()] });
      expect(r).toEqual({ accepted: 1, rejected: [] });
      await c.query("reset role");
      const rt = await c.query(`select status, cpu_load_pct, memory_used_pct, uptime_seconds, identity, model, routeros_version, consecutive_failures from routers where id = $1`, [router]);
      expect(rt.rows[0]).toMatchObject({ status: "online", cpu_load_pct: "23.00", memory_used_pct: "41.00", uptime_seconds: "86400", identity: "core-ruiru", routeros_version: "7.16.1", consecutive_failures: 0 });
      const ifs = await c.query(`select name, running, rx_bps::int8, mac_address::text from router_interfaces where router_id = $1 order by name`, [router]);
      expect(ifs.rows).toEqual([
        { name: "ether2", running: false, rx_bps: "0", mac_address: null },
        { name: "sfp-sfpplus1", running: true, rx_bps: "250000000", mac_address: "48:a9:8a:00:00:01" },
      ]);
      const sess = await c.query(`select username, customer_id, host(ip_address) as ip from network_sessions where router_id = $1 and ended_at is null order by username`, [router]);
      expect(sess.rows).toEqual([
        { username: `grace.${runId}`, customer_id: customer, ip: "10.10.0.5" },
        { username: "unknown.user", customer_id: null, ip: null },
      ]);
      const cust = await c.query(`select router_id from customers where id = $1`, [customer]);
      expect(cust.rows[0].router_id).toBe(router);
      const metrics = await c.query(`select metric, count(*)::int as n from network_metrics where router_id = $1 group by metric order by metric`, [router]);
      expect(Object.fromEntries(metrics.rows.map((m) => [m.metric, m.n]))).toEqual({ active_sessions: 1, cpu_load_pct: 1, hotspot_sessions: 1, memory_used_pct: 1, pppoe_sessions: 1, reachable: 1, rx_bps: 2, tx_bps: 2, uptime_seconds: 1 });
      // Telemetry is not written to the audit log.
      const audit = await c.query(`select count(*)::int as n from audit_logs where entity_type = 'routers' and entity_id = $1 and action = 'update'`, [router]);
      expect(audit.rows[0].n).toBe(0);
    });
  });

  it("ends sessions that are no longer reported", async () => {
    await asUser(null, async (c) => {
      await ingest(c, { routers: [reading({ collected_at: new Date(Date.now() - 60_000).toISOString() })] });
      await ingest(c, { routers: [reading({ sessions: [] })] });
      await c.query("reset role");
      const open = await c.query(`select count(*)::int as n from network_sessions where router_id = $1 and ended_at is null`, [router]);
      expect(open.rows[0].n).toBe(0);
    });
  });

  it("marks a router offline and opens one critical alert after two failed polls, then clears it", async () => {
    await asUser(null, async (c) => {
      const down = reading({ reachable: false, error: "connect ETIMEDOUT 192.168.88.1:443" });
      await ingest(c, { routers: [down] });
      await c.query("reset role");
      let alerts = await c.query(`select count(*)::int as n from network_alerts where router_id = $1`, [router]);
      expect(alerts.rows[0].n).toBe(0); // one miss is not an outage yet
      await c.query("set local role anon");
      await ingest(c, { routers: [down] });
      await ingest(c, { routers: [down] });
      await c.query("reset role");
      alerts = await c.query(`select severity, status, title, alert_type from network_alerts where router_id = $1`, [router]);
      expect(alerts.rows).toEqual([{ severity: "critical", status: "open", title: "Core Ruiru is not responding", alert_type: "router_offline" }]);
      const rt = await c.query(`select status, last_sync_error from routers where id = $1`, [router]);
      expect(rt.rows[0]).toEqual({ status: "offline", last_sync_error: "connect ETIMEDOUT 192.168.88.1:443" });
      const notes = await c.query(`select recipient_id from notifications where tenant_id = $1 and type = 'router_offline'`, [tenant]);
      expect(notes.rows.map((n) => n.recipient_id).sort()).toEqual([owner.id, netAdmin.id].sort()); // alerts:manage only

      await c.query("set local role anon");
      await ingest(c, { routers: [reading()] });
      await c.query("reset role");
      alerts = await c.query(`select status from network_alerts where router_id = $1`, [router]);
      expect(alerts.rows).toEqual([{ status: "resolved" }]);
    });
  });

  it("opens a high CPU warning once and clears it when load drops", async () => {
    await asUser(null, async (c) => {
      const hot = reading();
      (hot.system as Record<string, unknown>).cpu_load_pct = 97;
      await ingest(c, { routers: [hot] });
      await ingest(c, { routers: [hot] });
      await c.query("reset role");
      let a = await c.query(`select status from network_alerts where router_id = $1 and alert_type = 'high_cpu'`, [router]);
      expect(a.rows).toEqual([{ status: "open" }]);
      await c.query("set local role anon");
      await ingest(c, { routers: [reading()] });
      await c.query("reset role");
      a = await c.query(`select status from network_alerts where router_id = $1 and alert_type = 'high_cpu'`, [router]);
      expect(a.rows).toEqual([{ status: "resolved" }]);
    });
  });

  it("keeps simulated and real data apart and refuses other connectors' routers", async () => {
    await asUser(null, async (c) => {
      const r1 = await ingest(c, { simulated: true, routers: [reading()] });
      expect(r1.accepted).toBe(0);
      expect(r1.rejected[0].reason).toMatch(/Simulated data is refused/);
      const r2 = await ingest(c, { routers: [reading({ router_id: simRouter })] });
      expect(r2.rejected[0].reason).toMatch(/simulated test device/);
      const r3 = await ingest(c, { simulated: true, routers: [reading({ router_id: simRouter })] });
      expect(r3.accepted).toBe(1);
      await c.query("reset role");
      const m = await c.query(`select distinct data_source from network_metrics where router_id = $1`, [simRouter]);
      expect(m.rows).toEqual([{ data_source: "simulated" }]);
    });
  });

  it("refuses readings from far in the past or future", async () => {
    await asUser(null, async (c) => {
      const r = await ingest(c, { routers: [reading({ collected_at: new Date(Date.now() + 3_600_000).toISOString() })] });
      expect(r.rejected[0].reason).toMatch(/outside the accepted window/);
    });
  });
});

describe("router enforcement (suspend disconnects, restore reconnects)", () => {
  const enforce = (c: pg.PoolClient, on: boolean) => c.query(`select public.set_router_enforcement($1, $2)`, [tenant, on]);
  const commands = (c: pg.PoolClient) =>
    c.query(`select command_type, status, pppoe_username, router_id, result_message from router_commands where customer_id = $1 order by created_at, command_type`, [customer]).then((r) => r.rows);

  it("does nothing while the owner has not turned enforcement on", async () => {
    await asUser(owner, async (c) => {
      await c.query(`update customers set router_id = $2 where id = $1`, [customer, router]).catch(() => undefined);
      await c.query(`select public.suspend_subscription($1, 'Unpaid for October')`, [subscription]);
      expect(await commands(c)).toEqual([]);
    });
  });

  it("queues a disconnect, hands it to the connector once, and records the result", async () => {
    await asUser(owner, async (c) => {
      await enforce(c, true);
      await c.query(`select public.assign_customer_router($1, $2)`, [customer, router]);
      await c.query(`select public.suspend_subscription($1, 'Unpaid for October')`, [subscription]);
      expect(await commands(c)).toEqual([
        { command_type: "disconnect_pppoe", status: "queued", pppoe_username: `grace.${runId}`, router_id: router, result_message: null },
      ]);

      await c.query("set local role anon");
      const s1 = await sync(c);
      expect(s1.router_enforcement).toBe(true);
      expect(s1.commands).toEqual([expect.objectContaining({ type: "disconnect_pppoe", pppoe_username: `grace.${runId}`, router_id: router })]);
      expect((await sync(c)).commands).toEqual([]); // handed out once
      await c.query(`select public.connector_command_result($1, $2, now(), $3, true, 'PPPoE secret disabled and session removed')`, [token, nonce(), s1.commands[0].id]);

      await c.query("set local role authenticated");
      expect((await commands(c))[0]).toMatchObject({ status: "succeeded", result_message: "PPPoE secret disabled and session removed" });

      await c.query(`select public.restore_subscription($1, 'Paid')`, [subscription]);
      const after = await commands(c);
      expect(after.map((x) => [x.command_type, x.status])).toEqual([
        ["disconnect_pppoe", "succeeded"],
        ["reconnect_pppoe", "queued"],
      ]);
    });
  });

  it("cancels a disconnect that has not reached the router when the customer is restored", async () => {
    await asUser(owner, async (c) => {
      await enforce(c, true);
      await c.query(`select public.assign_customer_router($1, $2)`, [customer, router]);
      await c.query(`select public.suspend_subscription($1, 'Unpaid for October')`, [subscription]);
      await c.query(`select public.restore_subscription($1, 'Paid at the shop')`, [subscription]);
      expect((await commands(c)).map((x) => [x.command_type, x.status])).toEqual([["disconnect_pppoe", "cancelled"]]);
    });
  });

  it("blocks the command with a clear reason when the router is unknown, and retries once fixed", async () => {
    await asUser(owner, async (c) => {
      await enforce(c, true);
      await c.query(`select public.assign_customer_router($1, null)`, [customer]);
      await c.query(`select public.suspend_subscription($1, 'Unpaid for October')`, [subscription]);
      const [cmd] = await commands(c);
      expect(cmd.status).toBe("blocked");
      expect(cmd.result_message).toMatch(/which router/);
      const id = (await c.query(`select id from router_commands where customer_id = $1`, [customer])).rows[0].id;
      expect((await tryQuery(c, `select public.retry_router_command($1)`, [id])).ok).toBe(false);
      await c.query(`select public.assign_customer_router($1, $2)`, [customer, router]);
      await c.query(`select public.retry_router_command($1)`, [id]);
      expect((await commands(c))[0]).toMatchObject({ status: "queued", router_id: router });
    });
  });

  it("raises an alert when the router refuses the command, and re-queues unanswered ones", async () => {
    await asUser(owner, async (c) => {
      await enforce(c, true);
      await c.query(`select public.assign_customer_router($1, $2)`, [customer, router]);
      await c.query(`select public.suspend_subscription($1, 'Unpaid for October')`, [subscription]);
      await c.query("set local role anon");
      const s = await sync(c);
      await c.query(`select public.connector_command_result($1, $2, now(), $3, false, 'no such item (PPPoE secret not found)')`, [token, nonce(), s.commands[0].id]);
      await c.query("reset role");
      const alert = await c.query(`select title, severity from network_alerts where tenant_id = $1 and alert_type = 'command_failed'`, [tenant]);
      expect(alert.rows).toEqual([{ title: "Could not disconnect Grace Network", severity: "warning" }]);

      // A sent command with no answer for 10 minutes goes back in the queue.
      await c.query(`update router_commands set status = 'sent', sent_at = now() - interval '11 minutes', attempts = 1 where id = $1`, [s.commands[0].id]);
      await c.query(`delete from private.watchdog_runs where tenant_id = $1`, [tenant]);
      await c.query("set local role authenticated");
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: owner.id, role: "authenticated" })]);
      await c.query(`select public.network_watchdog($1)`, [tenant]);
      expect((await commands(c))[0].status).toBe("queued");
    });
  });

  it("only the owner can turn enforcement on, and commands cannot be written directly", async () => {
    await asUser(netAdmin, async (c) => {
      expect((await tryQuery(c, `select public.set_router_enforcement($1, true)`, [tenant])).ok).toBe(false);
      const ins = await tryQuery(c, `insert into router_commands (tenant_id, customer_id, command_type) values ($1, $2, 'disconnect_pppoe')`, [tenant, customer]);
      expect(ins.ok).toBe(false);
    });
  });
});

describe("watchdog, alerts and access", () => {
  it("marks routers unknown and warns when a connector goes quiet", async () => {
    await asUser(netAdmin, async (c) => {
      await c.query("reset role");
      await c.query(`update connector_agents set status = 'active', last_seen_at = now() - interval '10 minutes' where id = $1`, [agent]);
      await c.query(`update routers set status = 'online' where id = $1`, [router]);
      await c.query(`delete from private.watchdog_runs where tenant_id = $1`, [tenant]);
      await c.query("set local role authenticated");
      await c.query(`select public.network_watchdog($1)`, [tenant]);
      const r = await c.query(`select status from routers where id = $1`, [router]);
      expect(r.rows[0].status).toBe("unknown");
      const a = await c.query(`select alert_type, severity from network_alerts where tenant_id = $1 and alert_type = 'connector_offline'`, [tenant]);
      expect(a.rows).toEqual([{ alert_type: "connector_offline", severity: "warning" }]);
    });
  });

  it("lets alert managers acknowledge and resolve, but not support agents", async () => {
    const [{ id }] = await q<{ id: string }>(
      `insert into network_alerts (tenant_id, router_id, severity, alert_type, title, data_source) values ($1, $2, 'warning', 'test', 'Test alert', 'connector') returning id`,
      [tenant, router],
    );
    await asUser(support, async (c) => {
      expect((await tryQuery(c, `select public.update_alert($1, 'acknowledge')`, [id])).ok).toBe(false);
      expect((await c.query(`select count(*)::int as n from network_alerts where id = $1`, [id])).rows[0].n).toBe(1); // can see it
    });
    await asUser(netAdmin, async (c) => {
      await c.query(`select public.update_alert($1, 'acknowledge', 'Looking at it')`, [id]);
      await c.query(`select public.update_alert($1, 'resolve', 'Replaced the SFP')`, [id]);
      const a = await c.query(`select status, acknowledged_by, resolved_by, message from network_alerts where id = $1`, [id]);
      expect(a.rows[0]).toMatchObject({ status: "resolved", acknowledged_by: netAdmin.id, resolved_by: netAdmin.id });
      expect(a.rows[0].message).toContain("Resolution: Replaced the SFP");
    });
  });

  it("never lets anyone read router credentials back", async () => {
    await asUser(owner, async (c) => {
      expect((await c.query(`select count(*)::int as n from router_credentials`)).rows[0].n).toBe(0);
      const s = await c.query(`select * from public.router_credential_status($1)`, [tenant]);
      expect(Object.keys(s.rows[0]).sort()).toEqual(["router_id", "updated_at", "username"]);
      await c.query(`select public.set_router_credentials($1, 'fibrepulse-ro', 'v1:AAAA:BBBB:CCCC')`, [router]);
      expect((await tryQuery(c, `select public.set_router_credentials($1, 'x', 'plain-text-password')`, [router])).ok).toBe(false);
    });
    await asUser(support, async (c) => {
      expect((await tryQuery(c, `select public.set_router_credentials($1, 'x', 'v1:AAAA:BBBB:CCCC')`, [router])).ok).toBe(false);
    });
  });

  it("keeps network data inside its ISP and away from anonymous visitors", async () => {
    await asUser(otherOwner, async (c) => {
      for (const t of ["routers", "router_interfaces", "network_sessions", "network_metrics", "network_alerts", "router_commands", "connector_agents"]) {
        const r = await c.query(`select count(*)::int as n from ${t} where tenant_id = $1`, [tenant]);
        expect(r.rows[0].n, t).toBe(0);
      }
      expect((await tryQuery(c, `select public.network_watchdog($1)`, [tenant])).ok).toBe(false);
    });
    await asUser(null, async (c) => {
      expect((await tryQuery(c, `select count(*) from network_sessions`)).ok).toBe(false);
      expect((await tryQuery(c, `select count(*) from router_commands`)).ok).toBe(false);
    });
  });
});
