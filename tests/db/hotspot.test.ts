/**
 * Pilot client update (24 Nov 2026): hotspot users who buy time per device,
 * M-Pesa only, the Safaricom upstream check, people online, revenue split
 * hotspot / monthly, and scale for about 10,000 users.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, asUserCommit, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";

let owner: TestUser;
let finance: TestUser;
let support: TestUser;
let tenant: string;
let slug: string;
let agent: string;
let router: string;
let plan1h: string;
let plan24h: string;
let planMonth: string;
const token = `fpc_${randomBytes(24).toString("hex")}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const nonce = () => randomBytes(12).toString("hex");
const mpesaRef = () => `T${randomBytes(5).toString("hex").toUpperCase()}`;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}
const sync = (c: pg.PoolClient, radiusVersion: string | null = null) =>
  c.query(`select public.connector_sync($1, $2, now(), 'test', $3) as r`, [token, nonce(), radiusVersion]).then((r) => r.rows[0].r);
const ingest = (c: pg.PoolClient, payload: unknown) =>
  c.query(`select public.connector_ingest($1, $2, now(), $3::jsonb) as r`, [token, nonce(), JSON.stringify(payload)]).then((r) => r.rows[0].r);
const reading = (over: Record<string, unknown> = {}) => ({
  router_id: router,
  collected_at: new Date().toISOString(),
  reachable: true,
  system: { identity: "hs-gw", uptime_seconds: 100, cpu_load_pct: 10, memory_used_pct: 30 },
  ...over,
});
/** Run as the public API role or the server's service role, and commit. */
async function commitAs<T>(role: "anon" | "service_role", fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  owner = await createUser("hs-owner");
  finance = await createUser("hs-finance");
  support = await createUser("hs-support");
  slug = `hs-${runId}`;
  tenant = await asUserCommit(owner, (c) =>
    c.query(`select public.register_tenant('Thika Road WiFi Test', $1, 'Kiambu', 'Ruiru', '+254722000100', 'Owner') as id`, [slug]).then((r) => r.rows[0].id),
  );
  await q(`update tenants set status = 'active', settings = settings || '{"router_enforcement": true, "access_control": "radius"}' where id = $1`, [tenant]);
  await q(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'finance'), ($1, $3, 'support_agent')`, [tenant, finance.id, support.id]);
  [{ id: agent }] = await q<{ id: string }>(
    `insert into connector_agents (tenant_id, name, token_hash, token_prefix, status, last_seen_at) values ($1, 'Server room', $2, 'fpc_hs', 'active', now()) returning id`,
    [tenant, hash(token)],
  );
  [{ id: router }] = await q<{ id: string }>(
    `insert into routers (tenant_id, connector_agent_id, name, management_address, data_source) values ($1, $2, 'Hotspot gateway', '10.0.0.1', 'manual') returning id`,
    [tenant, agent],
  );
  await asUserCommit(owner, async (c) => {
    const mk = (name: string, minutes: number, price: number, usage = "unlimited") =>
      c.query(`select public.save_hotspot_plan($1, null, $2, $3, $4, 10, 10, $5) as id`, [tenant, name, minutes, price, usage]).then((r) => r.rows[0].id as string);
    plan1h = await mk("1 hour", 60, 10, "limited");
    plan24h = await mk("24 hours", 1440, 50, "limited");
    planMonth = await mk("Monthly unlimited", 43200, 700);
  });
});

afterAll(async () => {
  await pool.end();
});

describe("M-Pesa only", () => {
  it("an ISP registered through the app accepts only M-Pesa, and the database refuses other methods", async () => {
    const [t] = await q<{ m: string[] }>(`select settings -> 'payment_methods' as m from tenants where id = $1`, [tenant]);
    expect(t.m).toEqual(["mpesa"]);
    await asUser(finance, async (c) => {
      const bank = await tryQuery(
        c,
        `insert into payments (tenant_id, method, provider_reference, amount, transaction_at, data_source, recorded_by, status)
         values ($1, 'bank_transfer', 'BANK0001', 500, now(), 'manual', $2, 'successful')`,
        [tenant, finance.id],
      );
      expect(bank.ok === false && bank.error).toMatch(/only accepts M-Pesa/);
      const mpesa = await tryQuery(
        c,
        `insert into payments (tenant_id, method, provider_reference, amount, transaction_at, data_source, recorded_by, status)
         values ($1, 'mpesa', 'SKL4H7XY2Q', 500, now(), 'manual', $2, 'successful')`,
        [tenant, finance.id],
      );
      expect(mpesa.ok).toBe(true);
    });
  });

  it("only the owner changes the paybill, payment methods and upstream provider", async () => {
    await asUser(finance, async (c) => {
      const r = await tryQuery(c, `select public.save_service_settings($1, array['mpesa'], '123456', 'Safaricom', '0722000100', '8.8.8.8')`, [tenant]);
      expect(r.ok).toBe(false);
    });
    await asUserCommit(owner, async (c) => {
      const bad = await tryQuery(c, `select public.save_service_settings($1, array['mpesa'], '12', 'Safaricom', null, null)`, [tenant]);
      expect(bad.ok === false && bad.error).toMatch(/5 to 7 digits/);
      await c.query(`select public.save_service_settings($1, array['mpesa'], '4012345', 'Safaricom', '0722 000 100', '1.1.1.1')`, [tenant]);
      const [s] = (await c.query(`select settings from tenants where id = $1`, [tenant])).rows;
      expect(s.settings).toMatchObject({ mpesa_paybill: "4012345", upstream_provider: "Safaricom", upstream_support_phone: "0722 000 100", upstream_check_target: "1.1.1.1" });
    });
  });
});

describe("hotspot plans", () => {
  it("the owner manages plans; others can only look; prices are whole shillings", async () => {
    await asUser(finance, async (c) => {
      expect((await c.query(`select count(*)::int as n from hotspot_plans where tenant_id = $1`, [tenant])).rows[0].n).toBe(3);
      const r = await tryQuery(c, `select public.save_hotspot_plan($1, null, 'Sneaky', 60, 5, 10, 10)`, [tenant]);
      expect(r.ok).toBe(false);
    });
    await asUser(owner, async (c) => {
      const r = await tryQuery(c, `select public.save_hotspot_plan($1, null, 'Odd', 60, 9.5, 10, 10)`, [tenant]);
      expect(r.ok === false && r.error).toMatch(/whole shillings/);
    });
  });
});

describe("selling a code and using it on one device", () => {
  let voucher: string;
  let code: string;

  it("only the owner sells; the sale records an unverified M-Pesa payment and queues the code by SMS", async () => {
    await asUser(support, async (c) => {
      const r = await tryQuery(c, `select * from public.sell_hotspot_voucher($1, $2, '0712345678', $3)`, [tenant, plan24h, mpesaRef()]);
      expect(r.ok).toBe(false);
    });
    await asUser(owner, async (c) => {
      const bad = await tryQuery(c, `select * from public.sell_hotspot_voucher($1, $2, '0712345678', 'x')`, [tenant, plan24h]);
      expect(bad.ok === false && bad.error).toMatch(/M-Pesa transaction code/);
    });
    const ref = mpesaRef();
    const row = await asUserCommit(owner, (c) =>
      c.query(`select * from public.sell_hotspot_voucher($1, $2, '0712 345 678', $3)`, [tenant, plan24h, ref]).then((r) => r.rows[0]),
    );
    voucher = row.voucher_id;
    code = row.code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    const [v] = await q(`select v.status, v.price::int, v.phone, p.method, p.verification_status, p.data_source, p.provider_reference
                         from hotspot_vouchers v join payments p on p.id = v.payment_id where v.id = $1`, [voucher]);
    expect(v).toEqual({ status: "unused", price: 50, phone: "+254712345678", method: "mpesa", verification_status: "unverified", data_source: "manual", provider_reference: ref });
    const sms = await q<{ body: string }>(`select body from customer_sms_outbox where voucher_id = $1`, [voucher]);
    expect(sms[0].body).toContain(code);
    expect(sms[0].body.length).toBeLessThanOrEqual(160);
    // Staff actions are audited.
    const audit = await q(`select count(*)::int as n from audit_logs where entity_type = 'hotspot_vouchers' and entity_id = $1`, [voucher]);
    expect(audit[0].n).toBe(1);
  });

  it("RADIUS gets the live code with its duration; the list is only resent when something changed", async () => {
    await asUser(null, async (c) => {
      const first = await sync(c);
      const entry = first.radius_access.find((e: { username: string }) => e.username === code);
      // Time runs from payment (the pilot's choice), so RADIUS already has the end time.
      expect(entry).toMatchObject({ kind: "hotspot", allowed: true, duration_seconds: 86400, mac: null, download_mbps: 10, data_left_bytes: null });
      expect(entry.expires_at).not.toBeNull();
      const again = await sync(c, first.radius_version);
      expect(again.radius_access).toBeNull();
      expect(again.radius_version).toBe(first.radius_version);
    });
  });

  it("the first time the code is online it is tied to that device; its time still runs from payment", async () => {
    await commitAs("anon", async (c) => {
      const r = await ingest(c, {
        routers: [reading({ sessions: [{ type: "hotspot", username: code.toLowerCase(), address: "10.5.50.20", caller_id: "AA:BB:CC:00:11:22", uptime_seconds: 120 }] })],
      });
      expect(r).toEqual({ accepted: 1, rejected: [] });
    });
    const [v] = await q<{ status: string; mac: string; minutes: number; device: string | null; phone: string }>(
      `select v.status, v.mac_address::text as mac, round(extract(epoch from v.expires_at - v.created_at) / 60)::int as minutes,
              d.mac_address::text as device, d.last_phone as phone
       from hotspot_vouchers v left join hotspot_devices d on d.id = v.device_id where v.id = $1`,
      [voucher],
    );
    expect(v).toEqual({ status: "active", mac: "aa:bb:cc:00:11:22", minutes: 1440, device: "aa:bb:cc:00:11:22", phone: "+254712345678" });
  });

  it("when the time runs out the code expires and the device still online is disconnected on the router", async () => {
    await q(`update hotspot_vouchers set activated_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = $1`, [voucher]);
    await asUser(null, async (c) => {
      await c.query("reset role");
      await c.query(`select private.expire_hotspot_vouchers()`);
      const [v] = (await c.query(`select status, end_reason from hotspot_vouchers where id = $1`, [voucher])).rows;
      expect(v).toEqual({ status: "expired", end_reason: "Time used up" });
      await c.query("set local role anon");
      const s = await sync(c);
      expect(s.commands).toEqual([expect.objectContaining({ type: "disconnect_hotspot", pppoe_username: code, router_id: router })]);
      expect(s.radius_access.find((e: { username: string }) => e.username === code)).toBeUndefined();
    });
  });
});

describe("free codes, cancelling and outage compensation", () => {
  it("free codes need the owner and a reason; cancelling needs a reason; compensation extends running codes", async () => {
    await asUser(finance, async (c) => {
      expect((await tryQuery(c, `select * from public.give_free_hotspot_voucher($1, $2, null, 'Outage on Monday')`, [tenant, plan1h])).ok).toBe(false);
    });
    await asUser(owner, async (c) => {
      const noReason = await tryQuery(c, `select * from public.give_free_hotspot_voucher($1, $2, null, '')`, [tenant, plan1h]);
      expect(noReason.ok === false && noReason.error).toMatch(/reason/);
      const free = (await c.query(`select * from public.give_free_hotspot_voucher($1, $2, '0711000001', 'Outage on Monday')`, [tenant, plan1h])).rows[0];
      const [fv] = (await c.query(`select price::int, source, status, payment_id from hotspot_vouchers where id = $1`, [free.voucher_id])).rows;
      expect(fv).toEqual({ price: 0, source: "complimentary", status: "unused", payment_id: null });

      const sale = (await c.query(`select * from public.sell_hotspot_voucher($1, $2, null, $3)`, [tenant, plan1h, mpesaRef()])).rows[0];
      await c.query("reset role");
      await c.query(`update hotspot_vouchers set status = 'active', activated_at = now(), expires_at = now() + interval '30 minutes' where id = $1`, [sale.voucher_id]);
      await c.query("set local role authenticated");
      const n = (await c.query(`select public.compensate_hotspot_outage($1, 45, 'Safaricom outage 2-3 pm') as n`, [tenant])).rows[0].n;
      expect(n).toBeGreaterThanOrEqual(1);
      const [after] = (await c.query(`select round(extract(epoch from expires_at - now()) / 60)::int as left from hotspot_vouchers where id = $1`, [sale.voucher_id])).rows;
      expect(after.left).toBeGreaterThanOrEqual(74);

      const cancelNoReason = await tryQuery(c, `select public.cancel_hotspot_voucher($1, 'x')`, [sale.voucher_id]);
      expect(cancelNoReason.ok).toBe(false);
      await c.query(`select public.cancel_hotspot_voucher($1, 'Paid twice by mistake')`, [sale.voucher_id]);
      const [cv] = (await c.query(`select status, end_reason from hotspot_vouchers where id = $1`, [sale.voucher_id])).rows;
      expect(cv).toEqual({ status: "cancelled", end_reason: "Paid twice by mistake" });
    });
  });
});

describe("the hotspot buying page and M-Pesa", () => {
  it("shows plans to anyone, starts an unpaid purchase and never reveals the code before payment", async () => {
    await asUser(null, async (c) => {
      const p = (await c.query(`select public.hotspot_portal($1) as p`, [slug])).rows[0].p;
      expect(p.name).toBe("Thika Road WiFi Test");
      expect(p.plans.map((x: { name: string }) => x.name)).toEqual(["1 hour", "24 hours", "Monthly unlimited"]);
      expect(p.demo).toBe(false);
      expect(JSON.stringify(p)).not.toMatch(/tenant_id|settings/);
      const bad = await tryQuery(c, `select public.hotspot_portal_buy($1, $2, '12345', null)`, [slug, plan1h]);
      expect(bad.ok === false && bad.error).toMatch(/M-Pesa number/);
      const buy = (await c.query(`select public.hotspot_portal_buy($1, $2, '0799000111', 'de:ad:be:ef:00:01') as b`, [slug, plan24h])).rows[0].b;
      expect(buy).toMatchObject({ amount: 50, phone: "+254799000111" });
      const st = (await c.query(`select public.hotspot_portal_status($1, $2) as s`, [slug, buy.voucher_id])).rows[0].s;
      expect(st).toMatchObject({ status: "awaiting_payment", code: null });
      // Only demo ISPs may simulate a payment.
      const sim = await tryQuery(c, `select public.hotspot_portal_simulate_payment($1, $2)`, [slug, buy.voucher_id]);
      expect(sim.ok === false && sim.error).toMatch(/demo ISPs/);
      // The public can never confirm a payment.
      const confirm = await tryQuery(c, `select public.confirm_hotspot_payment($1, true, 'ABC123XYZ9', 50, null, now())`, [buy.voucher_id]);
      expect(confirm.ok).toBe(false);
    });
  });

  it("limits unpaid prompts per phone", async () => {
    await asUser(null, async (c) => {
      for (let i = 0; i < 3; i++) await c.query(`select public.hotspot_portal_buy($1, $2, '0799000222', null)`, [slug, plan1h]);
      const r = await tryQuery(c, `select public.hotspot_portal_buy($1, $2, '0799000222', null)`, [slug, plan1h]);
      expect(r.ok === false && r.error).toMatch(/Too many unpaid/);
    });
  });

  it("M-Pesa confirmation (server only) issues the code once, with a verified payment; failures and underpayment grant nothing", async () => {
    const mkBuy = (phone: string, planId: string) =>
      asUserCommit(owner, (c) => c.query(`select public.hotspot_portal_buy($1, $2, $3, null) as b`, [slug, planId, phone]).then((r) => r.rows[0].b));
    const ok = await mkBuy("0799000333", plan24h);
    const receipt = mpesaRef();
    await commitAs("service_role", async (c) => {
      const r = (await c.query(`select public.confirm_hotspot_payment($1, true, $2, 50, '254799000333', now()) as r`, [ok.voucher_id, receipt])).rows[0].r;
      expect(r.status).toBe("unused");
      const dup = (await c.query(`select public.confirm_hotspot_payment($1, true, $2, 50, '254799000333', now()) as r`, [ok.voucher_id, receipt])).rows[0].r;
      expect(dup.duplicate).toBe(true);
      const [p] = (await c.query(`select p.verification_status, p.data_source from hotspot_vouchers v join payments p on p.id = v.payment_id where v.id = $1`, [ok.voucher_id])).rows;
      expect(p).toEqual({ verification_status: "verified", data_source: "provider" });
      expect((await c.query(`select count(*)::int as n from payments where provider_reference = $1`, [receipt])).rows[0].n).toBe(1);

      const failed = await mkBuy("0799000444", plan1h);
      expect((await c.query(`select public.confirm_hotspot_payment($1, false, null, null, null, null) as r`, [failed.voucher_id])).rows[0].r.status).toBe("payment_failed");
      const under = await mkBuy("0799000555", plan24h);
      expect((await c.query(`select public.confirm_hotspot_payment($1, true, $2, 20, null, now()) as r`, [under.voucher_id, mpesaRef()])).rows[0].r).toMatchObject({ status: "payment_failed", reason: "underpaid" });
    });
    await asUser(null, async (c) => {
      const st = (await c.query(`select public.hotspot_portal_status($1, $2) as s`, [slug, ok.voucher_id])).rows[0].s;
      expect(st.code).toMatch(/^[A-Z2-9]{6}$/);
    });
  });

  it("money paid straight to the paybill picks the plan by amount; unknown amounts are kept for the owner", async () => {
    await commitAs("service_role", async (c) => {
      const receipt = mpesaRef();
      const r = (await c.query(`select public.record_paybill_hotspot_payment($1, $2, 700, '0712000999', 'monthly', now()) as r`, [tenant, receipt])).rows[0].r;
      expect(r.status).toBe("unused");
      const [v] = (await c.query(`select plan_id, source from hotspot_vouchers where id = $1`, [r.voucher_id])).rows;
      expect(v).toEqual({ plan_id: planMonth, source: "paybill" });
      const again = (await c.query(`select public.record_paybill_hotspot_payment($1, $2, 700, '0712000999', 'monthly', now()) as r`, [tenant, receipt])).rows[0].r;
      expect(again.duplicate).toBe(true);
      const odd = (await c.query(`select public.record_paybill_hotspot_payment($1, $2, 333, '0712000999', '', now()) as r`, [tenant, mpesaRef()])).rows[0].r;
      expect(odd.status).toBe("unmatched");
    });
  });

  it("a demo ISP's simulated payment issues a SIMULATED code that is never sent to RADIUS or counted as money", async () => {
    await q(`update tenants set settings = settings || '{"portal_demo": true}' where id = $1`, [tenant]);
    try {
      await asUser(null, async (c) => {
        const buy = (await c.query(`select public.hotspot_portal_buy($1, $2, '0799000666', null) as b`, [slug, plan1h])).rows[0].b;
        await c.query(`select public.hotspot_portal_simulate_payment($1, $2)`, [slug, buy.voucher_id]);
        const st = (await c.query(`select public.hotspot_portal_status($1, $2) as s`, [slug, buy.voucher_id])).rows[0].s;
        expect(st).toMatchObject({ status: "unused", simulated: true });
        const s = await sync(c);
        expect(s.radius_access.find((e: { username: string }) => e.username === st.code)).toBeUndefined();
      });
    } finally {
      await q(`update tenants set settings = settings - 'portal_demo' where id = $1`, [tenant]);
    }
  });
});

describe("network status: Safaricom upstream and people online", () => {
  it("two failed internet checks mean the upstream is down: alert, banner state and no sales", async () => {
    await asUser(null, async (c) => {
      const down = { target: "1.1.1.1", reachable: false, loss_pct: 100 };
      await ingest(c, { routers: [reading({ upstream: down, sessions: [{ type: "pppoe", username: "monthly.one" }, { type: "hotspot", username: "zz9999", caller_id: "AA:00:00:00:00:01" }] })] });
      await c.query("reset role");
      let st = (await c.query(`select private.network_state($1) as s`, [tenant])).rows[0].s;
      expect(st.state).toBe("ok"); // one failed check is not an outage
      await c.query("set local role anon");
      await ingest(c, { routers: [reading({ upstream: down, sessions: [{ type: "pppoe", username: "monthly.one" }, { type: "hotspot", username: "zz9999", caller_id: "AA:00:00:00:00:01" }] })] });
      await c.query("reset role");
      st = (await c.query(`select private.network_state($1) as s`, [tenant])).rows[0].s;
      expect(st).toMatchObject({ state: "upstream_down", provider: "Safaricom", provider_phone: "0722 000 100", online_hotspot: 1, online_pppoe: 1, online_total: 2 });
      const [a] = (await c.query(`select title, message, severity from network_alerts where tenant_id = $1 and alert_type = 'upstream_down' and status = 'open'`, [tenant])).rows;
      expect(a.title).toBe("Internet from Safaricom is down at Hotspot gateway");
      expect(a.message).toContain("Contact Safaricom on 0722 000 100");
      expect(a.severity).toBe("critical");
      await c.query("set local role anon");
      const buy = await tryQuery(c, `select public.hotspot_portal_buy($1, $2, '0799000777', null)`, [slug, plan1h]);
      expect(buy.ok === false && buy.error).toMatch(/internet is down/);
      expect((await c.query(`select public.hotspot_portal($1) as p`, [slug])).rows[0].p.network_ok).toBe(false);
      // Back up.
      await ingest(c, { routers: [reading({ upstream: { target: "1.1.1.1", reachable: true, loss_pct: 0, avg_ms: 18 } })] });
      await c.query("reset role");
      st = (await c.query(`select private.network_state($1) as s`, [tenant])).rows[0].s;
      expect(st.state).toBe("ok");
      const open = (await c.query(`select count(*)::int as n from network_alerts where tenant_id = $1 and alert_type = 'upstream_down' and status <> 'resolved'`, [tenant])).rows[0].n;
      expect(open).toBe(0);
    });
  });

  it("when no connector has reported for 3 minutes the site is unreachable and the online count is unknown", async () => {
    await asUser(owner, async (c) => {
      await c.query("reset role");
      await c.query(`update connector_agents set last_seen_at = now() - interval '10 minutes' where id = $1`, [agent]);
      await c.query("set local role authenticated");
      const st = (await c.query(`select public.network_status($1) as s`, [tenant])).rows[0].s;
      expect(st).toMatchObject({ state: "site_unreachable", online_total: null });
    });
    await asUser(null, async (c) => {
      expect((await tryQuery(c, `select public.network_status($1)`, [tenant])).ok).toBe(false);
    });
  });
});

describe("money: hotspot and monthly, by day and month", () => {
  it("splits verified collections into hotspot and monthly and shows unverified sales separately", async () => {
    await asUser(owner, async (c) => {
      const today = (await c.query(`select (now() at time zone 'Africa/Nairobi')::date::text as d`)).rows[0].d;
      const rows = (await c.query(`select * from public.revenue_by_service($1, $2::date - 2, $2::date, 'day')`, [tenant, today])).rows;
      expect(rows).toHaveLength(3);
      const t = rows[2];
      // Portal (50), paybill (700) and an underpaid portal purchase (20, kept
      // for follow-up) are hotspot money confirmed by M-Pesa.
      expect(Number(t.hotspot)).toBe(770);
      expect(t.hotspot_sales).toBe(3);
      // Paybill money that matched no plan is "unlinked".
      expect(Number(t.unlinked)).toBe(333);
      // Owner sales wait for statement verification.
      expect(Number(t.awaiting_verification)).toBeGreaterThanOrEqual(50);
      const month = (await c.query(`select * from public.revenue_by_service($1, date_trunc('month', $2::date)::date, $2::date, 'month')`, [tenant, today])).rows;
      expect(month).toHaveLength(1);
      expect(Number(month[0].hotspot)).toBe(770);
      const svc = (await c.query(`select * from public.revenue_breakdown($1, $2::date, $2::date, 'service')`, [tenant, today])).rows;
      expect(svc.find((r: { label: string }) => r.label === "Hotspot")).toMatchObject({ payments: 3 });
      const pkg = (await c.query(`select * from public.revenue_breakdown($1, $2::date, $2::date, 'package')`, [tenant, today])).rows;
      expect(pkg.map((r: { label: string }) => r.label)).toEqual(expect.arrayContaining(["Hotspot: Monthly unlimited", "Hotspot: 24 hours"]));
    });
    await asUser(support, async (c) => {
      expect((await tryQuery(c, `select * from public.revenue_by_service($1, current_date, current_date, 'day')`, [tenant])).ok).toBe(false);
    });
  });

  it("the hotspot summary counts codes and sales for the dashboard", async () => {
    await asUser(support, async (c) => {
      const s = (await c.query(`select public.hotspot_summary($1) as s`, [tenant])).rows[0].s;
      expect(s.plans).toBe(3);
      expect(s.plans_unlimited).toBe(1);
      expect(s.sold_today).toBeGreaterThanOrEqual(3);
      expect(s.active_codes).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Limited plans (data cap) and when time starts", () => {
  const MB = 1048576;
  const freeCode = (planId: string) =>
    asUserCommit(owner, (c) =>
      c.query(`select * from public.give_free_hotspot_voucher($1, $2, null, 'Testing the data cap')`, [tenant, planId]).then((r) => r.rows[0] as { voucher_id: string; code: string }),
    );

  it("a Limited plan carries a data cap; an Unlimited plan never does", async () => {
    await asUserCommit(owner, async (c) => {
      await c.query(`select public.save_hotspot_plan($1, $2, '3 hours', 180, 15, 10, 10, 'limited', 1024)`, [tenant, plan1h]);
      await c.query(`select public.save_hotspot_plan($1, $2, 'Monthly unlimited', 43200, 700, 10, 10, 'unlimited', 5000)`, [tenant, planMonth]);
    });
    const rows = await q<{ id: string; data_limit_mb: number | null }>(`select id, data_limit_mb from hotspot_plans where id in ($1, $2)`, [plan1h, planMonth]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.data_limit_mb]))).toEqual({ [plan1h]: 1024, [planMonth]: null });
  });

  it("the code is cut off when its data runs out, even with time left, and RADIUS gets the data left", async () => {
    const { voucher_id, code: c1 } = await freeCode(plan1h);
    const [v0] = await q<{ data_limit_mb: number; left_min: number }>(
      `select data_limit_mb, round(extract(epoch from expires_at - now()) / 60)::int as left_min from hotspot_vouchers where id = $1`,
      [voucher_id],
    );
    expect(v0).toEqual({ data_limit_mb: 1024, left_min: 180 });

    const session = (bytes: number) => ({ type: "hotspot", username: c1, address: "10.5.50.40", caller_id: "AA:BB:CC:00:44:44", uptime_seconds: 60, bytes_in: bytes / 4, bytes_out: (bytes * 3) / 4 });
    await commitAs("anon", (c) => ingest(c, { routers: [reading({ sessions: [session(600 * MB)] })] }));
    await asUser(null, async (c) => {
      const s = await sync(c);
      expect(s.radius_access.find((e: { username: string }) => e.username === c1)).toMatchObject({ data_left_bytes: 424 * MB });
    });
    // The phone drops off, then reconnects and uses another 500 MB: 1,100 MB in all.
    await commitAs("anon", (c) => ingest(c, { routers: [reading({ sessions: [] })] }));
    await commitAs("anon", (c) => ingest(c, { routers: [reading({ sessions: [session(500 * MB)] })] }));
    const [v] = await q<{ status: string; end_reason: string; used: string }>(
      `select v.status, v.end_reason, u.used_bytes::text as used from hotspot_vouchers v join hotspot_voucher_usage u on u.voucher_id = v.id where v.id = $1`,
      [voucher_id],
    );
    expect(v).toEqual({ status: "expired", end_reason: "Data used up", used: String(1100 * MB) });
    const [cmd] = await q<{ n: number }>(`select count(*)::int as n from router_commands where voucher_id = $1 and command_type = 'disconnect_hotspot'`, [voucher_id]);
    expect(cmd.n).toBe(1);
  });

  it("time runs from payment: a paid code that is never used runs out too", async () => {
    const { voucher_id } = await freeCode(plan24h);
    await q(`update hotspot_vouchers set expires_at = now() - interval '1 minute', created_at = now() - interval '25 hours' where id = $1`, [voucher_id]);
    await q(`select private.expire_hotspot_vouchers()`);
    const [v] = await q<{ status: string; end_reason: string }>(`select status, end_reason from hotspot_vouchers where id = $1`, [voucher_id]);
    expect(v).toEqual({ status: "expired", end_reason: "Time ended before the code was used" });
  });

  it("the paybill account number is shown on the WiFi page and used as the M-Pesa account", async () => {
    await asUserCommit(owner, (c) => c.query(`select public.save_service_settings($1, array['mpesa'], '222111', 'Safaricom', '0722000111', null, 'payment', '8068')`, [tenant]));
    await asUser(null, async (c) => {
      await c.query("set local role anon");
      const info = (await c.query(`select public.hotspot_portal($1) as i`, [slug])).rows[0].i;
      expect(info).toMatchObject({ paybill: "222111", account_number: "8068" });
    });
    const buy = await asUserCommit(owner, (c) => c.query(`select public.hotspot_portal_buy($1, $2, '0799000888', null) as b`, [slug, plan24h]).then((r) => r.rows[0].b));
    expect(buy.account_reference).toBe("8068");
    const bad = await asUserCommit(owner, (c) => tryQuery(c, `select public.save_service_settings($1, array['mpesa'], '222111', 'Safaricom', null, null, null, 'bad number!')`, [tenant]));
    expect(bad.ok).toBe(false);
  });

  it("an ISP can choose time from first login instead; then an unused code never expires", async () => {
    await asUserCommit(owner, (c) => c.query(`select public.save_service_settings($1, array['mpesa'], null, 'Safaricom', null, null, 'first_login')`, [tenant]));
    const { voucher_id } = await freeCode(plan24h);
    await q(`select private.expire_hotspot_vouchers()`);
    const [v] = await q<{ status: string; expires_at: string | null }>(`select status, expires_at from hotspot_vouchers where id = $1`, [voucher_id]);
    expect(v).toEqual({ status: "unused", expires_at: null });
    await asUserCommit(owner, (c) => c.query(`select public.save_service_settings($1, array['mpesa'], null, 'Safaricom', null, null, 'payment')`, [tenant]));
  });
});

describe("issuing a code by hand when a customer paid but got nothing", () => {
  const sell = (ref: string, planId = plan24h, phone: string | null = "0711000777") =>
    asUserCommit(owner, (c) => c.query(`select * from public.sell_hotspot_voucher($1, $2, $3, $4)`, [tenant, planId, phone, ref]).then((r) => r.rows[0] as { voucher_id: string; code: string }));

  it("ties the code to a paybill payment already in FibrePulse, and never gives one M-Pesa transaction two codes", async () => {
    const receipt = mpesaRef();
    // Paid Ksh 55 to the paybill: no plan costs that, so no code went out.
    await commitAs("service_role", async (c) => {
      const r = (await c.query(`select public.record_paybill_hotspot_payment($1, $2, 55, '254711000777', null, now()) as r`, [tenant, receipt])).rows[0].r;
      expect(r.status).toBe("unmatched");
    });
    const issued = await sell(receipt);
    const [v] = await q<{ data_source: string; amount: string; n: number }>(
      `select p.data_source, p.amount::text, (select count(*)::int from payments where provider_reference = $2) as n
       from hotspot_vouchers v join payments p on p.id = v.payment_id where v.id = $1`,
      [issued.voucher_id, receipt],
    );
    expect(v).toEqual({ data_source: "provider", amount: "55.00", n: 1 });
    const again = await asUserCommit(owner, (c) => tryQuery(c, `select * from public.sell_hotspot_voucher($1, $2, null, $3)`, [tenant, plan24h, receipt]));
    expect(again.ok === false && again.error).toContain(`already has WiFi code ${issued.code}`);
    // A late paybill confirmation for the same receipt is a no-op.
    await commitAs("service_role", async (c) => {
      const r = (await c.query(`select public.record_paybill_hotspot_payment($1, $2, 55, '254711000777', null, now()) as r`, [tenant, receipt])).rows[0].r;
      expect(r).toMatchObject({ duplicate: true, code: issued.code });
    });
  });

  it("refuses a payment smaller than the plan", async () => {
    const receipt = mpesaRef();
    await commitAs("service_role", (c) => c.query(`select public.record_paybill_hotspot_payment($1, $2, 20, null, null, now())`, [tenant, receipt]));
    const r = await asUserCommit(owner, (c) => tryQuery(c, `select * from public.sell_hotspot_voucher($1, $2, null, $3)`, [tenant, plan24h, receipt]));
    expect(r.ok === false && r.error).toMatch(/was Ksh 20.*costs Ksh 50/);
  });

  it("a WiFi-page payment that arrives after the owner issued a code by hand gets no second code", async () => {
    const receipt = mpesaRef();
    const buy = await asUserCommit(owner, (c) => c.query(`select public.hotspot_portal_buy($1, $2, '0799000666', null) as b`, [slug, plan24h]).then((r) => r.rows[0].b));
    const issued = await sell(receipt, plan24h, "0799000666");
    await commitAs("service_role", async (c) => {
      const r = (await c.query(`select public.confirm_hotspot_payment($1, true, $2, 50, '254799000666', now()) as r`, [buy.voucher_id, receipt])).rows[0].r;
      expect(r).toMatchObject({ status: "payment_failed", reason: "already_issued", code: issued.code });
    });
  });

  it("the owner can send a code again by SMS, to a new number if needed", async () => {
    const issued = await sell(mpesaRef(), plan24h, null);
    await asUserCommit(owner, (c) => c.query(`select public.resend_hotspot_code_sms($1, '0722333444')`, [issued.voucher_id]));
    const sms = await q<{ phone: string; body: string }>(`select phone, body from customer_sms_outbox where voucher_id = $1`, [issued.voucher_id]);
    expect(sms).toHaveLength(1);
    expect(sms[0].phone).toBe("+254722333444");
    expect(sms[0].body).toContain(issued.code);
    await asUser(support, async (c) => {
      const r = await tryQuery(c, `select public.resend_hotspot_code_sms($1, null)`, [issued.voucher_id]);
      expect(r.ok).toBe(false);
    });
  });
});

describe("scale: about 10,000 users", () => {
  it("ingests 3,000 online hotspot devices and answers the dashboard quickly with 10,000 codes on file", async () => {
    const [{ id: scaleAgent }] = await q<{ id: string }>(
      `insert into connector_agents (tenant_id, name, token_hash, token_prefix, status, last_seen_at) values ($1, 'Scale', $2, 'fpc_sc', 'active', now()) returning id`,
      [tenant, hash(token + "scale")],
    );
    const [{ id: scaleRouter }] = await q<{ id: string }>(
      `insert into routers (tenant_id, connector_agent_id, name, data_source) values ($1, $2, 'Scale gateway', 'manual') returning id`,
      [tenant, scaleAgent],
    );
    // 10,000 codes: 3,000 unused (about to be used), 2,000 running, 5,000 expired.
    await q(
      `insert into hotspot_vouchers (tenant_id, code, plan_id, plan_name, price, duration_minutes, download_mbps, upload_mbps, source, status,
                                     activated_at, expires_at, payment_id, reason, data_source)
       select $1, 'S' || lpad(g::text, 5, '0'), $2, '24 hours', 0, 1440, 10, 10, 'complimentary',
              case when g <= 3000 then 'unused' when g <= 5000 then 'active' else 'expired' end::public.hotspot_voucher_status,
              case when g > 3000 then now() - interval '2 hours' end,
              case when g > 5000 then now() - interval '1 hour' when g > 3000 then now() + interval '20 hours' end,
              null, 'scale test', 'manual'
       from generate_series(1, 10000) g`,
      [tenant, plan24h],
    );
    const sessions = Array.from({ length: 3000 }, (_, i) => ({
      type: "hotspot",
      username: "s" + String(i + 1).padStart(5, "0"),
      address: `10.5.${Math.floor(i / 250)}.${(i % 250) + 2}`,
      caller_id: `02:00:00:00:${((i >> 8) & 255).toString(16).padStart(2, "0")}:${(i & 255).toString(16).padStart(2, "0")}`,
      uptime_seconds: 60,
      bytes_in: 1000,
      bytes_out: 5000,
    }));
    const scaleToken = token + "scale";
    const run = async () => {
      const started = Date.now();
      await asUserCommit(owner, async (c) => {
        await c.query("set local role anon");
        await c.query(`select public.connector_ingest($1, $2, now(), $3::jsonb)`, [
          scaleToken,
          nonce(),
          JSON.stringify({ routers: [{ router_id: scaleRouter, collected_at: new Date().toISOString(), reachable: true, system: { cpu_load_pct: 30 }, sessions }] }),
        ]);
      });
      return Date.now() - started;
    };
    const first = await run();
    const second = await run(); // the steady state: every session already known
    const [act] = await q<{ n: number }>(`select count(*)::int as n from hotspot_vouchers where tenant_id = $1 and code ~ '^S[0-9]{5}$' and status = 'active' and device_id is not null`, [tenant]);
    expect(act.n).toBe(3000);
    expect(first).toBeLessThan(5000);
    expect(second).toBeLessThan(2000);

    const t0 = Date.now();
    await asUser(owner, async (c) => {
      await c.query(`select public.hotspot_summary($1)`, [tenant]);
      await c.query(`select public.network_status($1)`, [tenant]);
    });
    expect(Date.now() - t0).toBeLessThan(2000);

    const t1 = Date.now();
    const list = await asUser(null, async (c) => {
      await c.query("reset role");
      return (await c.query(`select jsonb_array_length(private.radius_access_list($1)) as n`, [tenant])).rows[0].n;
    });
    expect(list).toBeGreaterThanOrEqual(5000);
    expect(Date.now() - t1).toBeLessThan(2000);
    console.log(`scale: first ingest ${first} ms, steady ingest ${second} ms, RADIUS list ${list} codes`);
  }, 60_000);
});
