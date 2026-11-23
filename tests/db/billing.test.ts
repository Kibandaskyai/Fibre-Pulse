/**
 * Phase 2 billing rules: subscription periods, renewals, package changes,
 * invoices, payment verification, allocation, rejection and reversal.
 *
 * Fixture customers and packages are committed as `postgres`; every action
 * under test runs as a real signed-in role inside a rolled-back transaction.
 */
import { randomInt } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, count, pool, runId, tryQuery } from "../helpers/db";
import { buildWorld, type World } from "../helpers/fixtures";

let w: World;
const pkg: Record<string, string> = {};

async function newCustomer(tenantId: string, label: string): Promise<string> {
  const phone = `+2547${String(randomInt(0, 99_999_999)).padStart(8, "0")}`;
  const r = await pool.query(
    `insert into customers (tenant_id, full_name, phone, status) values ($1, $2, $3, 'active') returning id`,
    [tenantId, `Billing ${label}`, phone],
  );
  return r.rows[0].id;
}

async function addPackage(tenantId: string, name: string, price: number, period: string, days: number | null) {
  const r = await pool.query(
    `insert into service_packages (tenant_id, name, download_mbps, upload_mbps, price, billing_period, duration_days)
     values ($1, $2, 10, 10, $3, $4, $5) returning id`,
    [tenantId, name, price, period, days],
  );
  return r.rows[0].id as string;
}

async function purchase(c: pg.PoolClient, customer: string, packageId: string) {
  const r = await c.query(`select public.purchase_subscription($1, $2) as id`, [customer, packageId]);
  return r.rows[0].id as string;
}

async function sub(c: pg.PoolClient, id: string) {
  return (await c.query(`select * from subscriptions where id = $1`, [id])).rows[0];
}

async function invoiceFor(c: pg.PoolClient, subscriptionId: string) {
  return (await c.query(`select * from invoices where subscription_id = $1`, [subscriptionId])).rows[0];
}

let refSeq = 0;
async function recordPayment(c: pg.PoolClient, recorder: string, tenantId: string, customer: string | null, amount: number) {
  refSeq += 1;
  const r = await c.query(
    `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at,
                           status, data_source, recorded_by)
     values ($1, $2, 'bank_transfer', $3, $4, now(), 'successful', 'manual', $5) returning id`,
    [tenantId, customer, `BL${runId}${refSeq}`, amount, recorder],
  );
  return r.rows[0].id as string;
}

async function summary(c: pg.PoolClient, customer: string) {
  const r = await c.query(`select outstanding::float, credit::float from customer_account_summary where customer_id = $1`, [customer]);
  return r.rows[0] as { outstanding: number; credit: number };
}

beforeAll(async () => {
  w = await buildWorld();
  const t = w.a.tenantId;
  pkg.home10 = w.a.ids.package; // 2,500 monthly
  pkg.home20 = await addPackage(t, "Home 20", 3500, "monthly", null);
  pkg.daily = await addPackage(t, "Daily Pass", 50, "daily", 1);
  pkg.weekly = await addPackage(t, "Weekly 10", 300, "weekly", 7);
  pkg.custom = await addPackage(t, "Promo 30 days", 2000, "custom", 30);
  pkg.inactive = await addPackage(t, "Old Plan", 1000, "monthly", null);
  await pool.query(`update service_packages set status = 'archived' where id = $1`, [pkg.inactive]);
});

afterAll(async () => {
  await pool.end();
});

describe("period end dates (Africa/Nairobi)", () => {
  const end = async (from: string, period: string, days: number | null) =>
    (
      await pool.query(
        `select to_char(private.period_end($1::timestamptz, $2::billing_period, $3) at time zone 'Africa/Nairobi',
                        'YYYY-MM-DD HH24:MI') as v`,
        [from, period, days],
      )
    ).rows[0].v as string;

  it("monthly is a calendar month, clamped at month end", async () => {
    expect(await end("2026-01-31 10:00+03", "monthly", null)).toBe("2026-02-28 10:00");
    expect(await end("2028-01-31 10:00+03", "monthly", null)).toBe("2028-02-29 10:00");
    expect(await end("2026-03-15 08:30+03", "monthly", null)).toBe("2026-04-15 08:30");
  });

  it("daily, weekly and custom add local days", async () => {
    expect(await end("2026-03-01 20:00+03", "daily", 1)).toBe("2026-03-02 20:00");
    // 23:30 EAT is 20:30 UTC: the end date must follow the Kenyan calendar.
    expect(await end("2026-03-31 23:30+03", "daily", 1)).toBe("2026-04-01 23:30");
    expect(await end("2026-12-28 09:00+03", "weekly", 7)).toBe("2027-01-04 09:00");
    expect(await end("2026-02-01 12:00+03", "custom", 30)).toBe("2026-03-03 12:00");
  });
});

describe("buying a package", () => {
  it("a new subscription is active, priced from the package and invoiced", async () => {
    const customer = await newCustomer(w.a.tenantId, "new");
    await asUser(w.a.owner, async (c) => {
      const id = await purchase(c, customer, pkg.home20);
      const s = await sub(c, id);
      expect(s.status).toBe("active");
      expect(s.change_type).toBe("new");
      expect(Number(s.price)).toBe(3500);
      const months = await c.query(`select ($1::timestamptz - $2::timestamptz) between interval '28 days' and interval '31 days' as ok`, [
        s.expires_at,
        s.starts_at,
      ]);
      expect(months.rows[0].ok).toBe(true);

      const inv = await invoiceFor(c, id);
      expect(inv.status).toBe("issued");
      expect(Number(inv.total)).toBe(3500);
      expect(inv.invoice_number).toMatch(/^INV-\d{6}$/);
      const lines = await c.query(`select * from invoice_lines where invoice_id = $1`, [inv.id]);
      expect(lines.rowCount).toBe(1);
      expect(lines.rows[0].description).toContain("Home 20 (new)");
      expect((await summary(c, customer)).outstanding).toBe(3500);
    });
  });

  it("renewing the same package extends from the current expiry, so no paid days are lost", async () => {
    const customer = await newCustomer(w.a.tenantId, "renew");
    await asUser(w.a.owner, async (c) => {
      const first = await sub(c, await purchase(c, customer, pkg.weekly));
      const second = await sub(c, await purchase(c, customer, pkg.weekly));
      expect(second.change_type).toBe("renewal");
      expect(second.previous_subscription_id).toBe(first.id);
      const expected = await c.query(`select private.period_end($1, 'weekly', 7) as v`, [first.expires_at]);
      expect(new Date(second.expires_at).getTime()).toBe(new Date(expected.rows[0].v).getTime());
      expect((await sub(c, first.id)).status).toBe("expired");
      expect(await count(c, `select count(*) from subscriptions where customer_id = $1 and status = 'active'`, [customer])).toBe(1);
      expect(await count(c, `select count(*) from invoices where customer_id = $1`, [customer])).toBe(2);
    });
  });

  it("a dearer package is an upgrade and a cheaper one a downgrade, both starting now", async () => {
    const customer = await newCustomer(w.a.tenantId, "change");
    await asUser(w.a.owner, async (c) => {
      await purchase(c, customer, pkg.home10);
      const up = await sub(c, await purchase(c, customer, pkg.home20));
      expect(up.change_type).toBe("upgrade");
      const down = await sub(c, await purchase(c, customer, pkg.daily));
      expect(down.change_type).toBe("downgrade");
      const hours = (new Date(down.expires_at).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
    });
  });

  it("archived packages and terminated customers are refused", async () => {
    const customer = await newCustomer(w.a.tenantId, "refuse");
    await asUser(w.a.owner, async (c) => {
      const r = await tryQuery(c, `select public.purchase_subscription($1, $2)`, [customer, pkg.inactive]);
      expect(r.ok).toBe(false);
    });
    await pool.query(`update customers set status = 'terminated' where id = $1`, [customer]);
    await asUser(w.a.owner, async (c) => {
      const r = await tryQuery(c, `select public.purchase_subscription($1, $2)`, [customer, pkg.home10]);
      expect(r.ok).toBe(false);
    });
  });

  it("only roles with subscriptions:edit can sell; nobody can sell across ISPs", async () => {
    const customer = await newCustomer(w.a.tenantId, "who");
    for (const u of [w.financeA, w.supportA, w.networkA, w.technicianA, w.outsider, w.b.owner, w.superAdmin]) {
      const r = await asUser(u, (c) => tryQuery(c, `select public.purchase_subscription($1, $2)`, [customer, pkg.home10]));
      expect(r.ok, u.email).toBe(false);
    }
    // ISP A cannot sell ISP B's package to its own customer.
    const r = await asUser(w.a.owner, (c) => tryQuery(c, `select public.purchase_subscription($1, $2)`, [customer, w.b.ids.package]));
    expect(r.ok).toBe(false);
  });

  it("subscriptions cannot be created or edited directly, only through the functions", async () => {
    const customer = await newCustomer(w.a.tenantId, "direct");
    await asUser(w.a.owner, async (c) => {
      const ins = await tryQuery(
        c,
        `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period)
         values ($1, $2, $3, 'active', now(), now() + interval '1 year', 1, 'monthly')`,
        [w.a.tenantId, customer, pkg.home10],
      );
      expect(ins.ok).toBe(false);
      const id = await purchase(c, customer, pkg.home10);
      const upd = await tryQuery(c, `update subscriptions set expires_at = now() + interval '5 years' where id = $1`, [id]);
      expect(upd.ok && upd.rowCount).toBe(0);
    });
  });
});

describe("suspend, restore, cancel and expiry", () => {
  it("suspending needs a reason, is audited, and blocks renewal until restored", async () => {
    const customer = await newCustomer(w.a.tenantId, "suspend");
    await asUser(w.a.owner, async (c) => {
      const id = await purchase(c, customer, pkg.home10);
      expect((await tryQuery(c, `select public.suspend_subscription($1, 'no')`, [id])).ok).toBe(false);
      await c.query(`select public.suspend_subscription($1, 'Customer requested a pause')`, [id]);
      expect((await sub(c, id)).status).toBe("suspended");
      const audit = await c.query(
        `select reason from audit_logs where entity_type = 'subscriptions' and entity_id = $1 and action = 'update' order by id desc limit 1`,
        [id],
      );
      expect(audit.rows[0].reason).toBe("Customer requested a pause");

      expect((await tryQuery(c, `select public.purchase_subscription($1, $2)`, [customer, pkg.home10])).ok).toBe(false);
      const restored = await c.query(`select public.restore_subscription($1, 'Paid up') as s`, [id]);
      expect(restored.rows[0].s).toBe("active");
      expect((await sub(c, id)).suspension_reason).toBeNull();
    });
  });

  it("finance and support agents cannot suspend", async () => {
    const r = await asUser(w.financeA, (c) =>
      tryQuery(c, `select public.suspend_subscription($1, 'Not allowed here')`, [w.a.ids.subscription]),
    );
    expect(r.ok).toBe(false);
    const s = await asUser(w.supportA, (c) =>
      tryQuery(c, `select public.suspend_subscription($1, 'Not allowed here')`, [w.a.ids.subscription]),
    );
    expect(s.ok).toBe(false);
  });

  it("a subscription restored after its end date becomes expired, not active", async () => {
    const customer = await newCustomer(w.a.tenantId, "late-restore");
    const r = await pool.query(
      `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period, suspended_at, suspension_reason)
       values ($1, $2, $3, 'suspended', now() - interval '40 days', now() - interval '10 days', 2500, 'monthly', now() - interval '20 days', 'Unpaid')
       returning id`,
      [w.a.tenantId, customer, pkg.home10],
    );
    await asUser(w.a.owner, async (c) => {
      const s = await c.query(`select public.restore_subscription($1, 'Back') as s`, [r.rows[0].id]);
      expect(s.rows[0].s).toBe("expired");
    });
  });

  it("expire_due_subscriptions closes ended periods and is idempotent; outsiders cannot run it", async () => {
    const customer = await newCustomer(w.a.tenantId, "expire");
    const r = await pool.query(
      `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period)
       values ($1, $2, $3, 'active', now() - interval '2 months', now() - interval '1 month', 2500, 'monthly') returning id`,
      [w.a.tenantId, customer, pkg.home10],
    );
    await asUser(w.supportA, async (c) => {
      const n = await c.query(`select public.expire_due_subscriptions($1) as n`, [w.a.tenantId]);
      expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
      expect((await sub(c, r.rows[0].id)).status).toBe("expired");
      const again = await c.query(`select public.expire_due_subscriptions($1) as n`, [w.a.tenantId]);
      expect(again.rows[0].n).toBe(0);
    });
    const out = await asUser(w.b.owner, (c) => tryQuery(c, `select public.expire_due_subscriptions($1)`, [w.a.tenantId]));
    expect(out.ok).toBe(false);
  });

  it("cancel ends the subscription with a reason", async () => {
    const customer = await newCustomer(w.a.tenantId, "cancel");
    await asUser(w.a.owner, async (c) => {
      const id = await purchase(c, customer, pkg.home10);
      await c.query(`select public.cancel_subscription($1, 'Moving out of the area')`, [id]);
      const s = await sub(c, id);
      expect(s.status).toBe("cancelled");
      expect(s.ended_at).not.toBeNull();
      expect((await tryQuery(c, `select public.cancel_subscription($1, 'Again please')`, [id])).ok).toBe(false);
    });
  });
});

describe("payments: verification and allocation", () => {
  it("an unverified payment does not pay an invoice; verifying it does", async () => {
    const customer = await newCustomer(w.a.tenantId, "verify");
    await asUser(w.a.owner, async (c) => {
      const s = await purchase(c, customer, pkg.home20);
      const pay = await recordPayment(c, w.a.owner.id, w.a.tenantId, customer, 3500);
      expect((await invoiceFor(c, s)).status).toBe("issued");
      expect((await summary(c, customer)).outstanding).toBe(3500);

      await c.query(`select public.verify_payment($1, 'bank_statement', 'STMT-77', null)`, [pay]);
      const inv = await invoiceFor(c, s);
      expect(inv.status).toBe("paid");
      expect(Number(inv.amount_paid)).toBe(3500);
      const p = (await c.query(`select * from payments where id = $1`, [pay])).rows[0];
      expect(p.verification_status).toBe("verified");
      expect(p.verified_by).toBe(w.a.owner.id);
      expect(p.reconciliation_status).toBe("matched");
      expect(await count(c, `select count(*) from payment_reconciliation_records where payment_id = $1`, [pay])).toBe(1);
      expect(await summary(c, customer)).toEqual({ outstanding: 0, credit: 0 });
    });
  });

  it("part payment leaves the invoice partially paid; overpayment becomes credit used by the next invoice", async () => {
    const customer = await newCustomer(w.a.tenantId, "partial");
    await asUser(w.financeA, async (c) => {
      // Finance cannot sell, so the owner's purchase is simulated with create_invoice here.
      const inv = (await c.query(
        `select public.create_invoice($1, $2::jsonb) as id`,
        [customer, JSON.stringify([{ description: "Installation", category: "installation", quantity: 1, unit_price: 3000 }])],
      )).rows[0].id as string;

      const p1 = await recordPayment(c, w.financeA.id, w.a.tenantId, customer, 1000);
      await c.query(`select public.verify_payment($1, 'bank_statement', null, null)`, [p1]);
      let i = (await c.query(`select status, amount_paid::float from invoices where id = $1`, [inv])).rows[0];
      expect(i).toEqual({ status: "partially_paid", amount_paid: 1000 });

      const p2 = await recordPayment(c, w.financeA.id, w.a.tenantId, customer, 4000);
      await c.query(`select public.verify_payment($1, 'bank_statement', null, null)`, [p2]);
      i = (await c.query(`select status, amount_paid::float from invoices where id = $1`, [inv])).rows[0];
      expect(i).toEqual({ status: "paid", amount_paid: 3000 });
      expect(await summary(c, customer)).toEqual({ outstanding: 0, credit: 2000 });

      const inv2 = (await c.query(`select public.create_invoice($1, $2::jsonb) as id`, [
        customer,
        JSON.stringify([{ description: "Router", category: "equipment", quantity: 1, unit_price: 1500 }]),
      ])).rows[0].id as string;
      expect((await c.query(`select status from invoices where id = $1`, [inv2])).rows[0].status).toBe("paid");
      expect(await summary(c, customer)).toEqual({ outstanding: 0, credit: 500 });
    });
  });

  it("simulated payments can never be verified", async () => {
    const r = await pool.query(
      `insert into payments (tenant_id, method, amount, transaction_at, status, data_source) values ($1, 'mpesa', 100, now(), 'successful', 'simulated') returning id`,
      [w.a.tenantId],
    );
    const v = await asUser(w.a.owner, (c) => tryQuery(c, `select public.verify_payment($1, 'mpesa_statement', null, null)`, [r.rows[0].id]));
    expect(v.ok).toBe(false);
    expect(v.ok ? "" : v.error).toContain("Simulated");
  });

  it("the same M-Pesa receipt cannot be recorded twice in one ISP", async () => {
    const r = await asUser(w.financeA, async (c) => {
      const sql = `insert into payments (tenant_id, method, provider_reference, amount, transaction_at, status, data_source, recorded_by)
                   values ($1, 'mpesa', $2, 500, now(), 'successful', 'manual', $3)`;
      await c.query(sql, [w.a.tenantId, `QK${runId}X`, w.financeA.id]);
      return tryQuery(c, sql, [w.a.tenantId, `QK${runId}X`, w.financeA.id]);
    });
    expect(r.ok).toBe(false);
  });

  it("people cannot record a payment as already verified or provider-sourced", async () => {
    const r = await asUser(w.financeA, (c) =>
      tryQuery(
        c,
        `insert into payments (tenant_id, method, amount, transaction_at, status, data_source, recorded_by, verification_status, verified_at)
         values ($1, 'mpesa', 500, now(), 'successful', 'manual', $2, 'verified', now())`,
        [w.a.tenantId, w.financeA.id],
      ),
    );
    expect(r.ok).toBe(false);
    const p = await asUser(w.financeA, (c) =>
      tryQuery(
        c,
        `insert into payments (tenant_id, method, amount, transaction_at, status, data_source, recorded_by)
         values ($1, 'mpesa', 500, now(), 'successful', 'provider', $2)`,
        [w.a.tenantId, w.financeA.id],
      ),
    );
    expect(p.ok).toBe(false);
  });

  it("a rejected payment cannot later be verified", async () => {
    const customer = await newCustomer(w.a.tenantId, "reject");
    await asUser(w.financeA, async (c) => {
      const pay = await recordPayment(c, w.financeA.id, w.a.tenantId, customer, 800);
      await c.query(`select public.reject_payment($1, 'Not on the bank statement')`, [pay]);
      const p = (await c.query(`select verification_status, reconciliation_status from payments where id = $1`, [pay])).rows[0];
      expect(p).toEqual({ verification_status: "rejected", reconciliation_status: "disputed" });
      expect((await tryQuery(c, `select public.verify_payment($1, 'bank_statement', null, null)`, [pay])).ok).toBe(false);
    });
  });

  it("reversing a payment removes its allocations and reopens the invoice", async () => {
    const customer = await newCustomer(w.a.tenantId, "reverse");
    await asUser(w.a.owner, async (c) => {
      const s = await purchase(c, customer, pkg.home10);
      const pay = await recordPayment(c, w.a.owner.id, w.a.tenantId, customer, 2500);
      await c.query(`select public.verify_payment($1, 'bank_statement', null, null)`, [pay]);
      expect((await invoiceFor(c, s)).status).toBe("paid");

      expect((await tryQuery(c, `select public.reverse_payment($1, 'x')`, [pay])).ok).toBe(false);
      await c.query(`select public.reverse_payment($1, 'Bank recalled the transfer')`, [pay]);
      const inv = await invoiceFor(c, s);
      expect(inv.status).toBe("issued");
      expect(Number(inv.amount_paid)).toBe(0);
      expect(await count(c, `select count(*) from payment_allocations where payment_id = $1`, [pay])).toBe(0);
      expect((await c.query(`select status from payments where id = $1`, [pay])).rows[0].status).toBe("reversed");
      expect((await tryQuery(c, `select public.reverse_payment($1, 'Second reversal')`, [pay])).ok).toBe(false);
      expect(await summary(c, customer)).toEqual({ outstanding: 2500, credit: 0 });
    });
  });

  it("an unmatched deposit can be assigned to a customer and then pays their invoice", async () => {
    const customer = await newCustomer(w.a.tenantId, "assign");
    await asUser(w.a.owner, async (c) => {
      const s = await purchase(c, customer, pkg.home10);
      const pay = await recordPayment(c, w.a.owner.id, w.a.tenantId, null, 2500);
      await c.query(`select public.verify_payment($1, 'mpesa_statement', null, null)`, [pay]);
      expect((await invoiceFor(c, s)).status).toBe("issued");
      await c.query(`select public.assign_payment_customer($1, $2)`, [pay, customer]);
      expect((await invoiceFor(c, s)).status).toBe("paid");
      expect((await tryQuery(c, `select public.assign_payment_customer($1, $2)`, [pay, customer])).ok).toBe(false);
    });
  });

  it("manual allocation cannot exceed the unallocated balance or target another ISP's invoice", async () => {
    const customer = await newCustomer(w.a.tenantId, "alloc");
    await asUser(w.a.owner, async (c) => {
      const pay = await recordPayment(c, w.a.owner.id, w.a.tenantId, null, 1000);
      await c.query(`select public.verify_payment($1, 'bank_statement', null, null)`, [pay]);
      const s = await purchase(c, customer, pkg.home10);
      const inv = await invoiceFor(c, s);
      expect((await tryQuery(c, `select public.allocate_payment($1, $2, 1500)`, [pay, inv.id])).ok).toBe(false);
      expect((await tryQuery(c, `select public.allocate_payment($1, $2, 100)`, [pay, w.b.ids.invoice])).ok).toBe(false);
      await c.query(`select public.allocate_payment($1, $2, 600)`, [pay, inv.id]);
      await c.query(`select public.allocate_payment($1, $2, 400)`, [pay, inv.id]);
      const after = await invoiceFor(c, s);
      expect(after.status).toBe("partially_paid");
      expect(Number(after.amount_paid)).toBe(1000);
      expect((await tryQuery(c, `select public.allocate_payment($1, $2, 1)`, [pay, inv.id])).ok).toBe(false);
    });
  });

  it("payments, allocations and invoices cannot be changed by direct writes", async () => {
    await asUser(w.a.owner, async (c) => {
      const upd = await tryQuery(c, `update invoices set status = 'paid' where id = $1`, [w.a.ids.invoice]);
      expect(upd.ok && upd.rowCount).toBe(0);
      const alloc = await tryQuery(c, `insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values ($1, $2, $3, 1)`, [
        w.a.tenantId,
        w.a.ids.payment,
        w.a.ids.invoice,
      ]);
      expect(alloc.ok).toBe(false);
      const pay = await tryQuery(c, `update payments set status = 'reversed' where id = $1`, [w.a.ids.payment]);
      expect(pay.ok && pay.rowCount).toBe(0);
    });
  });

  it("another ISP cannot verify, reverse or reject this ISP's payments", async () => {
    for (const fn of [
      `select public.verify_payment($1, 'bank_statement', null, null)`,
      `select public.reject_payment($1, 'Not ours at all')`,
      `select public.reverse_payment($1, 'Not ours at all')`,
    ]) {
      const r = await asUser(w.b.owner, (c) => tryQuery(c, fn, [w.a.ids.payment]));
      expect(r.ok, fn).toBe(false);
    }
  });
});

describe("invoices", () => {
  it("an invoice with allocations cannot be voided; an unpaid one can, with a reason", async () => {
    const customer = await newCustomer(w.a.tenantId, "void");
    await asUser(w.financeA, async (c) => {
      const lines = JSON.stringify([{ description: "Relocation fee", category: "other", quantity: 1, unit_price: 500 }]);
      const inv = (await c.query(`select public.create_invoice($1, $2::jsonb) as id`, [customer, lines])).rows[0].id;
      expect((await tryQuery(c, `select public.void_invoice($1, 'no')`, [inv])).ok).toBe(false);
      await c.query(`select public.void_invoice($1, 'Raised in error')`, [inv]);
      expect((await c.query(`select status from invoices where id = $1`, [inv])).rows[0].status).toBe("void");

      const inv2 = (await c.query(`select public.create_invoice($1, $2::jsonb) as id`, [customer, lines])).rows[0].id;
      const pay = await recordPayment(c, w.financeA.id, w.a.tenantId, customer, 500);
      await c.query(`select public.verify_payment($1, 'bank_statement', null, null)`, [pay]);
      expect((await tryQuery(c, `select public.void_invoice($1, 'Raised in error')`, [inv2])).ok).toBe(false);
    });
  });

  it("an invoice needs at least one line, and support agents cannot raise one", async () => {
    const customer = await newCustomer(w.a.tenantId, "lines");
    const empty = await asUser(w.financeA, (c) => tryQuery(c, `select public.create_invoice($1, '[]'::jsonb)`, [customer]));
    expect(empty.ok).toBe(false);
    const support = await asUser(w.supportA, (c) =>
      tryQuery(c, `select public.create_invoice($1, $2::jsonb)`, [
        customer,
        JSON.stringify([{ description: "X", category: "other", quantity: 1, unit_price: 1 }]),
      ]),
    );
    expect(support.ok).toBe(false);
  });
});
