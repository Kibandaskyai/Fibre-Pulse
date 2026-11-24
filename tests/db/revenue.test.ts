/**
 * Phase 3 revenue analytics. A fresh ISP is built with known payments so
 * every figure can be checked exactly. Rows are written as `postgres`
 * (fixtures); the functions are called as real signed-in roles.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, asUserCommit, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";

let owner: TestUser;
let finance: TestUser;
let support: TestUser;
let network: TestUser;
let otherOwner: TestUser;
let tenant: string;
const ids: Record<string, string> = {};
let refSeq = 0;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}

async function customer(name: string, phone: string, estate: string, town: string, county: string) {
  const [r] = await q<{ id: string }>(
    `insert into customers (tenant_id, full_name, phone, estate, town, county, status, registered_on)
     values ($1, $2, $3, $4, $5, $6, 'active', '2026-10-05') returning id`,
    [tenant, name, phone, estate, town, county],
  );
  return r.id;
}

/** Insert a payment. `at` is a Kenyan local time like "2026-10-10 10:00". */
async function payment(opts: {
  customer: string | null;
  amount: number;
  at: string;
  method?: string;
  status?: string;
  verified?: boolean;
  source?: string;
}) {
  refSeq += 1;
  const verified = opts.verified ?? true;
  const [r] = await q<{ id: string }>(
    `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at, status,
                           verification_status, verified_at, data_source)
     values ($1, $2, $3, $4, $5, ($6 || ':00+03')::timestamptz, $7, $8, $9, $10) returning id`,
    [
      tenant,
      opts.customer,
      opts.method ?? "mpesa",
      `RV${runId}${refSeq}`,
      opts.amount,
      opts.at,
      opts.status ?? "successful",
      verified ? "verified" : "unverified",
      verified ? new Date() : null,
      opts.source ?? "manual",
    ],
  );
  return r.id;
}

async function invoice(customerId: string, total: number, issue: string, due: string, subscription: string | null = null, category = "subscription") {
  const [r] = await q<{ id: string }>(
    `insert into invoices (tenant_id, customer_id, subscription_id, issue_date, due_date, subtotal, total, status)
     values ($1, $2, $3, $4, $5, $6, $6, 'issued') returning id`,
    [tenant, customerId, subscription, issue, due, total],
  );
  await q(`insert into invoice_lines (tenant_id, invoice_id, description, category, quantity, unit_price, amount) values ($1, $2, 'Line', $3, 1, $4, $4)`, [
    tenant,
    r.id,
    category,
    total,
  ]);
  return r.id;
}

async function allocate(paymentId: string, invoiceId: string, amount: number) {
  await q(`insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values ($1, $2, $3, $4)`, [tenant, paymentId, invoiceId, amount]);
  await q(`select private.recompute_invoice($1)`, [invoiceId]);
}

const kpis = (c: pg.PoolClient, from: string, to: string, area: string | null = null) =>
  c.query(`select public.revenue_kpis($1, $2, $3, $4) as k`, [tenant, from, to, area]).then((r) => r.rows[0].k as Record<string, number | string>);

beforeAll(async () => {
  owner = await createUser("rev-owner");
  finance = await createUser("rev-finance");
  support = await createUser("rev-support");
  network = await createUser("rev-network");
  otherOwner = await createUser("rev-other-owner");
  tenant = await asUserCommit(owner, async (c) => {
    const r = await c.query(`select public.register_tenant('Revenue Test ISP', $1, 'Nairobi', 'Nairobi', null, 'Owner') as id`, [`rev-${runId}`]);
    return r.rows[0].id as string;
  });
  await asUserCommit(otherOwner, (c) => c.query(`select public.register_tenant('Other ISP', $1)`, [`rev-other-${runId}`]));
  await q(`update tenants set status = 'active', settings = settings || '{"payment_methods":["mpesa","bank_transfer","other"]}' where id = $1`, [tenant]);
  for (const [u, role] of [
    [finance, "finance"],
    [support, "support_agent"],
    [network, "network_admin"],
  ] as const) {
    await q(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, $3)`, [tenant, u.id, role]);
  }

  const [pkg] = await q<{ id: string }>(
    `insert into service_packages (tenant_id, name, download_mbps, upload_mbps, price, billing_period) values ($1, 'Starter', 20, 20, 2000, 'monthly') returning id`,
    [tenant],
  );
  ids.kasarani = await customer("Grace Test", "+254711000101", "Kasarani", "Nairobi", "Nairobi");
  ids.ruiru = await customer("Brian Test", "+254711000102", "Ruiru", "Ruiru", "Kiambu");

  const [sub] = await q<{ id: string }>(
    `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period)
     values ($1, $2, $3, 'active', '2026-10-01 09:00+03', '2026-11-01 09:00+03', 2000, 'monthly') returning id`,
    [tenant, ids.kasarani, pkg.id],
  );

  // October 2026 activity (all times Kenyan).
  ids.subInvoice = await invoice(ids.kasarani, 2000, "2026-10-01", "2026-10-01", sub.id);
  ids.installInvoice = await invoice(ids.ruiru, 1500, "2026-10-02", "2026-10-09", null, "installation");
  ids.p1 = await payment({ customer: ids.kasarani, amount: 2000, at: "2026-10-01 22:30" }); // 19:30 UTC, still 1 Oct in Kenya
  await allocate(ids.p1, ids.subInvoice, 2000);
  ids.p2 = await payment({ customer: ids.ruiru, amount: 2500, at: "2026-10-03 01:30", method: "bank_transfer" }); // 2 Oct 22:30 UTC
  await allocate(ids.p2, ids.installInvoice, 1500); // 1,000 left as credit
  await payment({ customer: ids.kasarani, amount: 500, at: "2026-10-04 10:00", verified: false }); // awaiting verification
  await payment({ customer: ids.kasarani, amount: 700, at: "2026-10-05 10:00", verified: false, source: "simulated" });
  await payment({ customer: ids.ruiru, amount: 300, at: "2026-10-06 10:00", status: "reversed" });
  await payment({ customer: ids.ruiru, amount: 200, at: "2026-10-07 10:00", status: "failed", verified: false });
  await payment({ customer: null, amount: 400, at: "2026-10-08 10:00" }); // unmatched deposit, verified

  // An unpaid invoice 45 days overdue and a payment made right now.
  const due45 = (await q<{ d: string }>(`select to_char((now() at time zone 'Africa/Nairobi')::date - 45, 'YYYY-MM-DD') as d`))[0].d;
  ids.overdue = await invoice(ids.ruiru, 999, due45, due45);
  const nowLocal = (await q<{ d: string }>(`select to_char(now() at time zone 'Africa/Nairobi', 'YYYY-MM-DD HH24:MI') as d`))[0].d;
  await payment({ customer: ids.kasarani, amount: 50, at: nowLocal });
});

afterAll(async () => {
  await pool.end();
});

describe("revenue_kpis", () => {
  it("counts only verified successful payments as collected", async () => {
    const k = await asUser(owner, (c) => kpis(c, "2026-10-01", "2026-10-31"));
    expect(Number(k.collected)).toBe(4900); // 2,000 + 2,500 + 400
    expect(Number(k.collected_count)).toBe(3);
    expect(Number(k.collected_mpesa)).toBe(2400);
    expect(Number(k.collected_bank)).toBe(2500);
    expect(Number(k.awaiting_verification)).toBe(500);
    expect(Number(k.simulated_excluded)).toBe(700);
    expect(Number(k.reversed)).toBe(300);
    expect(Number(k.recognised)).toBe(3500); // applied to invoices
    expect(Number(k.unapplied_credit)).toBe(1400); // 1,000 credit + 400 unmatched
    expect(Number(k.paying_customers)).toBe(2);
  });

  it("uses Kenyan dates, not UTC dates", async () => {
    await asUser(owner, async (c) => {
      // 1 Oct 22:30 EAT is 1 Oct; 3 Oct 01:30 EAT is 3 Oct even though it is 2 Oct in UTC.
      expect(Number((await kpis(c, "2026-10-01", "2026-10-01")).collected)).toBe(2000);
      expect(Number((await kpis(c, "2026-10-02", "2026-10-02")).collected)).toBe(0);
      expect(Number((await kpis(c, "2026-10-03", "2026-10-03")).collected)).toBe(2500);
    });
  });

  it("filters by county, town or estate", async () => {
    await asUser(finance, async (c) => {
      expect(Number((await kpis(c, "2026-10-01", "2026-10-31", "kiambu")).collected)).toBe(2500);
      expect(Number((await kpis(c, "2026-10-01", "2026-10-31", "Kasarani")).collected)).toBe(2000);
      expect(Number((await kpis(c, "2026-10-01", "2026-10-31", "Mombasa")).collected)).toBe(0);
    });
  });

  it("dashboard windows include a payment made just now", async () => {
    const k = await asUser(owner, (c) => kpis(c, "2026-10-01", "2026-10-31"));
    expect(Number(k.collected_today)).toBe(50);
    expect(Number(k.collected_this_week)).toBeGreaterThanOrEqual(50);
    expect(Number(k.collected_this_month)).toBeGreaterThanOrEqual(50);
  });

  it("reports outstanding and overdue balances", async () => {
    const k = await asUser(owner, (c) => kpis(c, "2026-10-01", "2026-10-31"));
    expect(Number(k.outstanding)).toBe(999);
    expect(Number(k.overdue)).toBe(999);
    expect(Number(k.outstanding_customers)).toBe(1);
  });

  it("refuses invalid ranges", async () => {
    const r = await asUser(owner, (c) => tryQuery(c, `select public.revenue_kpis($1, '2026-10-31', '2026-10-01')`, [tenant]));
    expect(r.ok).toBe(false);
  });
});

describe("series and breakdowns", () => {
  it("daily series fills empty days and adds up to the total", async () => {
    const rows = await asUser(owner, (c) =>
      c.query(`select bucket::text, collected::float, reversed::float from public.revenue_series($1, '2026-10-01', '2026-10-31', 'day')`, [tenant]),
    );
    expect(rows.rowCount).toBe(31);
    expect(rows.rows.reduce((s, r) => s + r.collected, 0)).toBe(4900);
    expect(rows.rows.find((r) => r.bucket === "2026-10-03")?.collected).toBe(2500);
    expect(rows.rows.find((r) => r.bucket === "2026-10-06")?.reversed).toBe(300);
  });

  it("monthly series buckets by Kenyan month", async () => {
    const rows = await asUser(owner, (c) =>
      c.query(`select bucket::text, collected::float from public.revenue_series($1, '2026-09-01', '2026-10-31', 'month')`, [tenant]),
    );
    expect(rows.rows).toEqual([
      { bucket: "2026-09-01", collected: 0 },
      { bucket: "2026-10-01", collected: 4900 },
    ]);
  });

  it("by package follows money to invoices and keeps credit separate; rows add up", async () => {
    const rows = await asUser(owner, (c) =>
      c.query(`select label, amount::float from public.revenue_breakdown($1, '2026-10-01', '2026-10-31', 'package')`, [tenant]),
    );
    const map = Object.fromEntries(rows.rows.map((r) => [r.label, r.amount]));
    expect(map).toEqual({ Starter: 2000, "Installation charges": 1500, "Credit not yet applied to an invoice": 1400 });
  });

  it("by area and by method add up to the collected total", async () => {
    await asUser(owner, async (c) => {
      const area = await c.query(`select label, amount::float from public.revenue_breakdown($1, '2026-10-01', '2026-10-31', 'area')`, [tenant]);
      expect(Object.fromEntries(area.rows.map((r) => [r.label, r.amount]))).toEqual({ Ruiru: 2500, Kasarani: 2000, "Not linked to a customer": 400 });
      const method = await c.query(`select label, amount::float from public.revenue_breakdown($1, '2026-10-01', '2026-10-31', 'method')`, [tenant]);
      expect(Object.fromEntries(method.rows.map((r) => [r.label, r.amount]))).toEqual({ "Bank transfer": 2500, "M-Pesa": 2400 });
    });
  });

  it("ageing puts a 45-day-old invoice in the 31–60 bucket", async () => {
    const rows = await asUser(finance, (c) => c.query(`select bucket, invoices, amount::float from public.outstanding_ageing($1)`, [tenant]));
    expect(rows.rows.find((r) => r.bucket === "31–60 days overdue")).toEqual({ bucket: "31–60 days overdue", invoices: 1, amount: 999 });
    expect(rows.rows).toHaveLength(5);
  });

  it("subscription mix and customer growth", async () => {
    await asUser(owner, async (c) => {
      const mix = await c.query(`select package, active, monthly_value::float from public.subscription_distribution($1)`, [tenant]);
      expect(mix.rows).toEqual([{ package: "Starter", active: 1, monthly_value: 2000 }]);
      const growth = await c.query(`select new_customers, total_customers from public.customer_growth($1, 60)`, [tenant]);
      expect(growth.rows.reduce((s, r) => s + r.new_customers, 0)).toBe(2);
    });
  });
});

describe("who can see revenue", () => {
  it("support agents and network admins are refused; finance and the owner are allowed", async () => {
    for (const u of [support, network]) {
      const r = await asUser(u, (c) => tryQuery(c, `select public.revenue_kpis($1, '2026-10-01', '2026-10-31')`, [tenant]));
      expect(r.ok, u.email).toBe(false);
      const s = await asUser(u, (c) => tryQuery(c, `select * from public.revenue_series($1, '2026-10-01', '2026-10-31')`, [tenant]));
      expect(s.ok, u.email).toBe(false);
    }
    const f = await asUser(finance, (c) => tryQuery(c, `select public.revenue_kpis($1, '2026-10-01', '2026-10-31')`, [tenant]));
    expect(f.ok).toBe(true);
  });

  it("another ISP's owner cannot read this ISP's revenue", async () => {
    for (const sql of [
      `select public.revenue_kpis($1, '2026-10-01', '2026-10-31')`,
      `select * from public.revenue_breakdown($1, '2026-10-01', '2026-10-31', 'package')`,
      `select * from public.outstanding_ageing($1)`,
      `select * from public.subscription_distribution($1)`,
      `select * from public.customer_growth($1)`,
    ]) {
      const r = await asUser(otherOwner, (c) => tryQuery(c, sql, [tenant]));
      expect(r.ok, sql).toBe(false);
    }
    const areas = await asUser(otherOwner, (c) => c.query(`select * from public.customer_areas($1)`, [tenant]));
    expect(areas.rowCount).toBe(0); // RLS hides the rows
  });

  it("anonymous visitors cannot call the functions", async () => {
    const r = await asUser(null, (c) => tryQuery(c, `select public.revenue_kpis($1, '2026-10-01', '2026-10-31')`, [tenant]));
    expect(r.ok).toBe(false);
  });
});
