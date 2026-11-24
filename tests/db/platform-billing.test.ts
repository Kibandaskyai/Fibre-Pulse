/**
 * Phase 6: commercial agreements, the fee engine, platform invoices,
 * platform analytics and support access.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, asUserCommit, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";

let superAdmin: TestUser;
let supportAdmin: TestUser;
let owner: TestUser;
let finance: TestUser;
let network: TestUser;
let tenant: string;
let customer: string;
let lateNight: string;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}
const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asUserCommit(superAdmin, (c) => c.query(sql, params).then((r) => r.rows as T[]));
const adminTry = (sql: string, params: unknown[] = []) => asUser(superAdmin, (c) => tryQuery(c, sql, params));

async function payment(ref: string, amount: number, at: string, opts: { category?: string; verify?: boolean } = {}) {
  const [{ id }] = await q<{ id: string }>(
    `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at, status, data_source, revenue_category)
     values ($1, $2, 'mpesa', $3, $4, $5, 'successful', 'manual', $6) returning id`,
    [tenant, customer, `${ref}${runId}`.toUpperCase(), amount, at, opts.category ?? "subscription"],
  );
  if (opts.verify !== false) await q(`update payments set verification_status = 'verified', verified_at = now() where id = $1`, [id]);
  return id;
}

const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};

beforeAll(async () => {
  superAdmin = await createUser("pb-super", { platformRole: "super_admin" });
  supportAdmin = await createUser("pb-support", { platformRole: "support_admin" });
  owner = await createUser("pb-owner");
  finance = await createUser("pb-finance");
  network = await createUser("pb-network");
  tenant = await asUserCommit(owner, (c) => c.query(`select public.register_tenant('Billing ISP', $1) as id`, [`pb-${runId}`]).then((r) => r.rows[0].id));
  await q(`update tenants set status = 'active' where id = $1`, [tenant]);
  await q(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'finance'), ($1, $3, 'network_admin')`, [tenant, finance.id, network.id]);
  [{ id: customer }] = await q<{ id: string }>(
    `insert into customers (tenant_id, full_name, phone, status) values ($1, 'Halima Said', '+254711000777', 'active') returning id`,
    [tenant],
  );
  await payment("PBA", 100000, "2026-10-15T10:00:00+03:00");
  await payment("PBI", 5000, "2026-10-16T10:00:00+03:00", { category: "installation" });
  await payment("PBU", 20000, "2026-10-17T10:00:00+03:00", { verify: false });
  lateNight = await payment("PBL", 2000, "2026-10-31T23:30:00+03:00"); // 20:30 UTC, still October in Kenya
  await payment("PBN", 7000, "2026-11-01T01:00:00+03:00"); // 31 Oct in UTC, November in Kenya
});

afterAll(async () => {
  await pool.end();
});

describe("commercial agreements", () => {
  it("the draft made at registration starts on the first of the next month", async () => {
    const [d] = await q<{ effective_from: Date; status: string }>(`select effective_from, status from commercial_agreements where tenant_id = $1 order by version limit 1`, [tenant]);
    expect(d.status).toBe("draft");
    expect(new Date(d.effective_from).getDate()).toBe(1);
  });
  it("only super admins manage agreements; drafts start on the first of a month", async () => {
    const [{ id: draft }] = await q<{ id: string }>(`select id from commercial_agreements where tenant_id = $1 and status = 'draft'`, [tenant]);
    for (const u of [owner, supportAdmin]) {
      const r = await asUser(u, (c) => tryQuery(c, `select public.admin_sign_agreement($1, 'Someone')`, [draft]));
      expect(r.ok).toBe(false);
    }
    const bad = await adminTry(
      `select public.admin_save_agreement($1, $2, 0.0275, 'gross', '{installation,equipment,other}', '2026-10-15', null)`,
      [tenant, draft],
    );
    expect(bad.ok).toBe(false);
    const sub = await adminTry(`select public.admin_save_agreement($1, $2, 0.0275, 'gross', '{subscription}', '2026-10-01', null)`, [tenant, draft]);
    expect(sub.ok).toBe(false);
    await admin(`select public.admin_save_agreement($1, $2, 0.0275, 'gross', '{installation,equipment,other}', '2026-10-01', 'Pilot terms')`, [tenant, draft]);
    expect((await adminTry(`select public.admin_sign_agreement($1, '')`, [draft])).ok).toBe(false);
    await admin(`select public.admin_sign_agreement($1, 'Jane Wairimu, Director')`, [draft]);
    const [a] = await q<{ status: string; signed_by_name: string }>(`select status, signed_by_name from commercial_agreements where id = $1`, [draft]);
    expect(a).toMatchObject({ status: "active", signed_by_name: "Jane Wairimu, Director" });
    const audit = await q(`select 1 from audit_logs where entity_id = $1 and reason like 'Agreement version 1 signed%'`, [draft]);
    expect(audit.length).toBe(1);
  });
});

describe("fee engine", () => {
  it("charges 2.75% of verified subscription collections dated in the month in Kenyan time", async () => {
    const [r] = await admin<{ result: string; eligible_amount: string; fee_amount: string; payment_count: number; fee_rate: string }>(
      `select * from public.admin_calculate_fees($1, '2026-10-01')`,
      [tenant],
    );
    expect(r.result).toBe("calculated");
    expect(r.eligible_amount).toBe("102000.00"); // excludes installation, unverified and the 1 Nov payment
    expect(r.fee_amount).toBe("2805.00");
    expect(r.payment_count).toBe(2);
    expect(r.fee_rate).toBe("0.0275");
  });

  it("recalculating never charges twice; a reversal becomes an adjustment", async () => {
    const [same] = await admin<{ result: string }>(`select * from public.admin_calculate_fees($1, '2026-10-01')`, [tenant]);
    expect(same.result).toBe("unchanged");
    await q(`update payments set status = 'reversed' where id = $1`, [lateNight]);
    const [adj] = await admin<{ result: string; eligible_amount: string; fee_amount: string; total_fee: string }>(
      `select * from public.admin_calculate_fees($1, '2026-10-01')`,
      [tenant],
    );
    expect(adj).toMatchObject({ result: "adjustment", eligible_amount: "-2000.00", fee_amount: "-55.00", total_fee: "2750.00" });
    const rows = await q(`select reason from platform_fee_records where tenant_id = $1 and adjustment_of is not null`, [tenant]);
    expect(String(rows[0].reason)).toContain("102,000.00");
  });

  it("refuses unfinished months and months without a signed agreement", async () => {
    expect((await adminTry(`select * from public.admin_calculate_fees($1, $2)`, [tenant, nextMonth()])).ok).toBe(false);
    expect((await adminTry(`select * from public.admin_calculate_fees($1, '2026-08-01')`, [tenant])).ok).toBe(false);
  });

  it("fee records are permanent, even for the database owner", async () => {
    const upd = await pool.query(`update platform_fee_records set fee_amount = 1 where tenant_id = $1`, [tenant]).then(() => "ok").catch(() => "refused");
    expect(upd).toBe("refused");
    const del = await pool.query(`delete from platform_fee_records where tenant_id = $1`, [tenant]).then(() => "ok").catch(() => "refused");
    expect(del).toBe("refused");
  });

  it("a new rate cannot reach back into charged months, and history keeps the old rate", async () => {
    const early = await adminTry(
      `select public.admin_save_agreement($1, null, 0.025, 'gross', '{installation,equipment,other}', '2026-10-01', null)`,
      [tenant],
    );
    expect(early.ok).toBe(false);
    const [{ id: v2 }] = await admin<{ id: string }>(
      `select public.admin_save_agreement($1, null, 0.025, 'gross', '{installation,equipment,other}', '2026-11-01', 'Volume discount') as id`,
      [tenant],
    );
    await admin(`select public.admin_sign_agreement($1, 'Jane Wairimu, Director')`, [v2]);
    const list = await q<{ version: number; status: string; effective_to: string | null }>(
      `select version, status, to_char(effective_to, 'YYYY-MM-DD') as effective_to from commercial_agreements where tenant_id = $1 order by version`,
      [tenant],
    );
    expect(list.find((a) => a.version === 1)).toMatchObject({ status: "superseded", effective_to: "2026-11-01" });
    expect(list.find((a) => a.status === "active")?.version).toBeGreaterThan(1);
    const rates = await q<{ fee_rate: string }>(`select distinct fee_rate from platform_fee_records where tenant_id = $1`, [tenant]);
    expect(rates.map((r) => r.fee_rate)).toEqual(["0.0275"]);
  });
});

describe("platform invoices", () => {
  let invoice: string;

  it("an invoice collects every calculated fee and tells the ISP", async () => {
    expect((await asUser(owner, (c) => tryQuery(c, `select public.admin_issue_platform_invoice($1, 14, 0, null)`, [tenant]))).ok).toBe(false);
    [{ id: invoice }] = await admin<{ id: string }>(`select public.admin_issue_platform_invoice($1, 14, 0, 'October 2026') as id`, [tenant]);
    const [inv] = await q<{ invoice_number: string; subtotal: string; total: string; status: string }>(
      `select invoice_number, subtotal, total, status from platform_invoices where id = $1`,
      [invoice],
    );
    expect(inv).toMatchObject({ subtotal: "2750.00", total: "2750.00", status: "issued" });
    expect(inv.invoice_number).toMatch(/^FP-\d{4}-\d{5}$/);
    const pending = await q(`select 1 from platform_fee_records where tenant_id = $1 and status = 'calculated'`, [tenant]);
    expect(pending.length).toBe(0);
    expect((await adminTry(`select public.admin_issue_platform_invoice($1, 14, 0, null)`, [tenant])).ok).toBe(false);
    const notes = await q(`select title from notifications where tenant_id = $1 and recipient_id = $2 and link = '/settings/billing'`, [tenant, finance.id]);
    expect(notes.length).toBe(1);
  });

  it("owner and finance see their invoice; network admin and other roles do not", async () => {
    const seen = (u: TestUser) => asUser(u, (c) => c.query(`select count(*)::int as n from platform_invoices where tenant_id = $1`, [tenant]).then((r) => r.rows[0].n));
    expect(await seen(owner)).toBe(1);
    expect(await seen(finance)).toBe(1);
    expect(await seen(network)).toBe(0);
    const write = await asUser(owner, (c) => tryQuery(c, `update platform_invoices set status = 'paid' where id = $1`, [invoice]));
    if (write.ok) expect(write.rowCount).toBe(0);
  });

  it("voiding releases the fees for a new invoice; payment closes it", async () => {
    expect((await adminTry(`select public.admin_void_platform_invoice($1, 'no')`, [invoice])).ok).toBe(false);
    await admin(`select public.admin_void_platform_invoice($1, 'Wrong payment terms')`, [invoice]);
    const [{ id: again }] = await admin<{ id: string }>(`select public.admin_issue_platform_invoice($1, 30, 0.16, null) as id`, [tenant]);
    const [inv] = await q<{ tax_amount: string; total: string }>(`select tax_amount, total from platform_invoices where id = $1`, [again]);
    expect(inv).toMatchObject({ tax_amount: "440.00", total: "3190.00" });
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
    expect((await adminTry(`select public.admin_record_platform_payment($1, '', $2)`, [again, today])).ok).toBe(false);
    await admin(`select public.admin_record_platform_payment($1, 'QK12ABC34', $2)`, [again, today]);
    const [paid] = await q<{ status: string; payment_reference: string }>(`select status, payment_reference from platform_invoices where id = $1`, [again]);
    expect(paid).toMatchObject({ status: "paid", payment_reference: "QK12ABC34" });
    expect((await adminTry(`select public.admin_void_platform_invoice($1, 'Changed my mind')`, [again])).ok).toBe(false);
    const amounts = await pool.query(`update platform_invoices set total = 1 where id = $1`, [again]).then(() => "ok").catch(() => "refused");
    expect(amounts).toBe("refused");
  });
});

describe("platform analytics", () => {
  it("super admins get totals; support admins and ISP staff do not", async () => {
    const [{ s }] = await admin<{ s: Record<string, number> }>(`select public.admin_platform_summary() as s`);
    expect(Number(s.fees_total)).toBeGreaterThanOrEqual(2750);
    expect(Number(s.paid_total)).toBeGreaterThanOrEqual(3190);
    const isp = await admin<{ tenant_id: string; fees_total: string; agreement_state: string; customers: number }>(`select * from public.admin_isp_revenue()`);
    expect(isp.find((r) => r.tenant_id === tenant)).toMatchObject({ fees_total: "2750.00", agreement_state: "signed", customers: 1 });
    const monthly = await admin<{ month: string; fees: string }>(`select to_char(month, 'YYYY-MM') as month, fees from public.admin_platform_monthly(3)`);
    expect(monthly.length).toBe(3);
    for (const u of [supportAdmin, owner]) {
      expect((await asUser(u, (c) => tryQuery(c, `select public.admin_platform_summary()`))).ok).toBe(false);
      expect((await asUser(u, (c) => tryQuery(c, `select * from public.admin_isp_revenue()`))).ok).toBe(false);
    }
  });
});

describe("support access", () => {
  it("staff request, the owner approves for at most 72 hours, and can revoke", async () => {
    const short = await asUser(supportAdmin, (c) => tryQuery(c, `select public.request_support_access($1, 'help')`, [tenant]));
    expect(short.ok).toBe(false);
    expect((await asUser(owner, (c) => tryQuery(c, `select public.request_support_access($1, 'I want to look around')`, [tenant]))).ok).toBe(false);
    const grant = await asUserCommit(supportAdmin, (c) =>
      c.query(`select public.request_support_access($1, 'Connector stopped syncing since Monday') as id`, [tenant]).then((r) => r.rows[0].id as string),
    );
    expect((await asUser(supportAdmin, (c) => tryQuery(c, `select public.request_support_access($1, 'Second request while open')`, [tenant]))).ok).toBe(false);
    expect((await q(`select 1 from notifications where tenant_id = $1 and recipient_id = $2 and link = '/settings/support-access'`, [tenant, owner.id])).length).toBe(1);

    const canSee = () => asUser(supportAdmin, (c) => c.query(`select count(*)::int as n from service_packages where tenant_id = $1`, [tenant]).then((r) => r.rows[0].n as number));
    await q(`insert into service_packages (tenant_id, name, download_mbps, upload_mbps, price, billing_period) values ($1, 'Lite', 10, 10, 1500, 'monthly')`, [tenant]);
    expect(await canSee()).toBe(0);

    expect((await asUser(finance, (c) => tryQuery(c, `select public.decide_support_access($1, 'approve', 24)`, [grant]))).ok).toBe(false);
    expect((await asUser(owner, (c) => tryQuery(c, `select public.decide_support_access($1, 'approve', 100)`, [grant]))).ok).toBe(false);
    await asUserCommit(owner, (c) => c.query(`select public.decide_support_access($1, 'approve', 24)`, [grant]));
    expect(await canSee()).toBe(1);

    const listed = await asUser(supportAdmin, (c) => c.query(`select state from public.admin_support_grants() where id = $1`, [grant]).then((r) => r.rows[0]?.state));
    expect(listed).toBe("active");

    await asUserCommit(owner, (c) => c.query(`select public.decide_support_access($1, 'revoke', null)`, [grant]));
    expect(await canSee()).toBe(0);
    const state = await asUser(superAdmin, (c) => c.query(`select state from public.admin_support_grants() where id = $1`, [grant]).then((r) => r.rows[0]?.state));
    expect(state).toBe("revoked");
    const audit = await asUser(superAdmin, (c) => c.query(`select count(*)::int as n from audit_logs where entity_type = 'support_access_grants' and entity_id = $1`, [grant]).then((r) => r.rows[0].n));
    expect(audit).toBeGreaterThanOrEqual(3);
  });
});
