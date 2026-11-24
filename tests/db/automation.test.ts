/**
 * Phase 7: expired packages disconnect, scheduled expiry, RADIUS access
 * control, and automatic monthly platform billing.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, asUserCommit, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";

let owner: TestUser;
let finance: TestUser;
let superAdmin: TestUser;
let tenant: string;
let router: string;
let pkg: string;
const token = `fpc_${randomBytes(24).toString("hex")}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const nonce = () => randomBytes(12).toString("hex");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}

async function customer(name: string, username: string) {
  const [{ id }] = await q<{ id: string }>(
    `insert into customers (tenant_id, full_name, phone, status, pppoe_username, router_id)
     values ($1, $2, $3, 'active', $4, $5) returning id`,
    [tenant, name, `+2547110${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`, `${username}.${runId}`, router],
  );
  return id;
}

async function subscription(customerId: string, expires: string) {
  const [{ id }] = await q<{ id: string }>(
    `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period)
     values ($1, $2, $3, 'active', now() - interval '30 days', $4::timestamptz, 2000, 'monthly') returning id`,
    [tenant, customerId, pkg, expires],
  );
  return id;
}

const commandsFor = (c: pg.PoolClient | typeof pool, customerId: string) =>
  c.query(`select command_type, status, reason from router_commands where customer_id = $1 order by created_at`, [customerId]).then((r) => r.rows);

beforeAll(async () => {
  owner = await createUser("auto-owner");
  finance = await createUser("auto-finance");
  superAdmin = await createUser("auto-super", { platformRole: "super_admin" });
  tenant = await asUserCommit(owner, (c) => c.query(`select public.register_tenant('Automation ISP', $1) as id`, [`auto-${runId}`]).then((r) => r.rows[0].id));
  await q(`update tenants set status = 'active', settings = settings || '{"router_enforcement": true}' where id = $1`, [tenant]);
  await q(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'finance')`, [tenant, finance.id]);
  const [{ id: agent }] = await q<{ id: string }>(
    `insert into connector_agents (tenant_id, name, token_hash, token_prefix) values ($1, 'Auto NOC', $2, 'fpc_auto') returning id`,
    [tenant, hash(token)],
  );
  [{ id: router }] = await q<{ id: string }>(
    `insert into routers (tenant_id, connector_agent_id, name, management_address, data_source) values ($1, $2, 'Auto Core', '192.168.88.1', 'manual') returning id`,
    [tenant, agent],
  );
  [{ id: pkg }] = await q<{ id: string }>(
    `insert into service_packages (tenant_id, name, download_mbps, upload_mbps, price, billing_period) values ($1, 'Starter', 20, 20, 2000, 'monthly') returning id`,
    [tenant],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("expired packages disconnect", () => {
  it("a package that runs out queues a disconnect; the scheduled check finds it", async () => {
    const cust = await customer("Expiry Kamau", "expiry");
    await subscription(cust, new Date(Date.now() - 60_000).toISOString());
    const c = await pool.connect();
    try {
      await c.query("begin");
      const [{ n }] = (await c.query(`select private.expire_all_due_subscriptions() as n`)).rows;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(await commandsFor(c, cust)).toEqual([{ command_type: "disconnect_pppoe", status: "queued", reason: "Package ended without renewal" }]);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("renewing after expiry reconnects; replacing a package early never disconnects", async () => {
    const late = await customer("Late Renewer", "late");
    await subscription(late, new Date(Date.now() - 60_000).toISOString());
    const early = await customer("Early Upgrader", "early");
    await subscription(early, new Date(Date.now() + 10 * 86_400_000).toISOString());
    // Expire it for real, and mark the disconnect done as the connector would.
    await q(`update subscriptions set status = 'expired', ended_at = expires_at where customer_id = $1 and status = 'active'`, [late]);
    await q(`update router_commands set status = 'succeeded', completed_at = now() where customer_id = $1`, [late]);
    await asUser(owner, async (c) => {
      await c.query(`select public.purchase_subscription($1, $2)`, [late, pkg]);
      expect((await commandsFor(c, late)).map((x) => [x.command_type, x.status])).toEqual([
        ["disconnect_pppoe", "succeeded"],
        ["reconnect_pppoe", "queued"],
      ]);
      await c.query(`select public.purchase_subscription($1, $2)`, [early, pkg]);
      expect(await commandsFor(c, early)).toEqual([]);
    });
  });

  it("the expiry and billing schedules are installed", async () => {
    const jobs = await q<{ jobname: string; schedule: string }>(`select jobname, schedule from cron.job where jobname like 'fibrepulse-%' order by jobname`);
    expect(jobs).toEqual([
      { jobname: "fibrepulse-expire-subscriptions", schedule: "*/5 * * * *" },
      { jobname: "fibrepulse-monthly-billing", schedule: "0 3 1 * *" },
    ]);
  });
});

describe("RADIUS access control", () => {
  it("only the owner chooses the mode", async () => {
    await asUser(finance, async (c) => {
      expect((await tryQuery(c, `select public.set_access_control($1, 'radius')`, [tenant])).ok).toBe(false);
    });
    await asUser(owner, async (c) => {
      expect((await tryQuery(c, `select public.set_access_control($1, 'hotspot')`, [tenant])).ok).toBe(false);
      expect((await tryQuery(c, `select public.set_access_control($1, 'radius')`, [tenant])).ok).toBe(true);
    });
  });

  it("the connector receives who may connect and at what speed, only in RADIUS mode", async () => {
    const live = await customer("Radius Live", "rlive");
    await subscription(live, new Date(Date.now() + 5 * 86_400_000).toISOString());
    const lapsed = await customer("Radius Lapsed", "rlapsed");
    await asUser(owner, async (c) => {
      await c.query("set local role anon");
      const before = (await c.query(`select public.connector_sync($1, $2, now()) as r`, [token, nonce()])).rows[0].r;
      expect(before.access_control).toBe("router_secrets");
      expect(before.radius_access).toBeNull();

      await c.query("set local role authenticated");
      await c.query(`select public.set_access_control($1, 'radius')`, [tenant]);
      await c.query("set local role anon");
      const after = (await c.query(`select public.connector_sync($1, $2, now()) as r`, [token, nonce()])).rows[0].r;
      expect(after.access_control).toBe("radius");
      const byName = new Map((after.radius_access as { username: string }[]).map((e) => [e.username, e]));
      expect(byName.get(`rlive.${runId}`)).toMatchObject({ allowed: true, download_mbps: 20, upload_mbps: 20 });
      expect(byName.get(`rlapsed.${runId}`)).toMatchObject({ allowed: false, download_mbps: null });
      void lapsed;
    });
  });
});

describe("SMS outbox", () => {
  it("only the delivery worker (service role) can claim and mark SMS", async () => {
    await asUser(owner, async (c) => {
      expect((await tryQuery(c, `select * from public.outbox_claim_sms(10)`)).ok).toBe(false);
      expect((await tryQuery(c, `select public.outbox_mark(gen_random_uuid(), 'sent')`)).ok).toBe(false);
    });
    await asUser(null, async (c) => {
      expect((await tryQuery(c, `select * from public.outbox_claim_sms(10)`)).ok).toBe(false);
    });
  });

  it("claims pending SMS with the staff member's phone and counts the attempt", async () => {
    await q(`update profiles set phone = '+254711000999' where id = $1`, [owner.id]);
    const [{ id: n }] = await q<{ id: string }>(
      `insert into notifications (tenant_id, recipient_id, type, title, body) values ($1, $2, 'system', 'Test SMS', 'Body') returning id`,
      [tenant, owner.id],
    );
    await q(`insert into notification_outbox (notification_id, tenant_id, recipient_id, channel) values ($1, $2, $3, 'sms') on conflict do nothing`, [n, tenant, owner.id]);
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role service_role");
      const rows = (await c.query(`select * from public.outbox_claim_sms(500)`)).rows.filter((r) => r.title === "Test SMS");
      expect(rows).toEqual([expect.objectContaining({ phone: "+254711000999", attempts: 1 })]);
      await c.query(`select public.outbox_mark($1, 'sent')`, [rows[0].id]);
      const [o] = (await c.query(`select status, sent_at from notification_outbox where id = $1`, [rows[0].id])).rows;
      expect(o.status).toBe("sent");
      expect(o.sent_at).not.toBeNull();
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("automatic monthly platform billing", () => {
  it("only super admins or the scheduled job may run it", async () => {
    await asUser(owner, async (c) => {
      await c.query(`select set_config('fibrepulse.system_job', 'on', true)`);
      const r = await tryQuery(c, `select public.admin_run_monthly_billing()`);
      expect(r.ok).toBe(false);
    });
  });

  it("calculates last month for every ISP and issues invoices, recording the run", async () => {
    await asUser(superAdmin, async (c) => {
      // Sign an agreement for this ISP from October 2026 and add a verified October payment.
      const [{ id: draft }] = (await c.query(`select id from commercial_agreements where tenant_id = $1 and status = 'draft'`, [tenant])).rows;
      const id = (await c.query(`select public.admin_save_agreement($1, $2, 0.0275, 'gross', '{installation,equipment,other}', '2026-10-01', null) as id`, [tenant, draft])).rows[0].id;
      await c.query(`select public.admin_sign_agreement($1, 'Automation Director')`, [id]);
      await c.query("reset role");
      const [{ id: pay }] = (await c.query(
        `insert into payments (tenant_id, method, provider_reference, amount, transaction_at, status, data_source, revenue_category)
         values ($1, 'bank_transfer', $2, 40000, '2026-10-20T10:00:00+03:00', 'successful', 'manual', 'subscription') returning id`,
        [tenant, `AUTO${runId}`.toUpperCase()],
      )).rows;
      await c.query(`update payments set verification_status = 'verified', verified_at = now() where id = $1`, [pay]);
      await c.query("set local role authenticated");

      const run = (await c.query(`select * from public.admin_run_monthly_billing('2026-10-01')`)).rows[0];
      expect(run.trigger).toBe("manual");
      const mine = (run.results as { tenant_id: string; invoice?: string; amount?: number; fees?: string }[]).filter((r) => r.tenant_id === tenant);
      expect(mine.find((r) => r.fees)).toMatchObject({ fees: "calculated" });
      const invoiced = mine.find((r) => r.invoice);
      expect(invoiced?.invoice).toMatch(/^FP-\d{4}-\d{5}$/);
      expect(Number(invoiced?.amount)).toBe(1100);

      const inv = (await c.query(`select total, notes from platform_invoices where invoice_number = $1`, [invoiced!.invoice])).rows[0];
      expect(Number(inv.total)).toBe(1100);
      expect(inv.notes).toMatch(/Issued automatically/);

      // Running again changes nothing for this ISP.
      const again = (await c.query(`select * from public.admin_run_monthly_billing('2026-10-01')`)).rows[0];
      expect((again.results as { tenant_id: string; invoice?: string }[]).filter((r) => r.tenant_id === tenant && r.invoice)).toEqual([]);
    });
  });

  it("the scheduled job runs without a signed-in user", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`select private.scheduled_monthly_billing()`);
      const [run] = (await c.query(`select trigger, finished_at from platform_billing_runs order by started_at desc limit 1`)).rows;
      expect(run.trigger).toBe("schedule");
      expect(run.finished_at).not.toBeNull();
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("ISP staff cannot read billing runs", async () => {
    await asUser(owner, async (c) => {
      expect((await c.query(`select count(*)::int as n from platform_billing_runs`)).rows[0].n).toBe(0);
    });
  });
});
