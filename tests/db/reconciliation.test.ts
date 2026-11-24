/**
 * Phase 3 statement reconciliation. Payments are written as `postgres`
 * (fixtures); reconcile_statement is called as real signed-in roles.
 * Each `asUser` block rolls back, so every test starts from the same rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, asUserCommit, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";

let owner: TestUser;
let finance: TestUser;
let support: TestUser;
let otherOwner: TestUser;
let tenant: string;
let otherTenant: string;
let customer: string;
let invoice: string;
const ref = (s: string) => `RC${runId}${s}`.toUpperCase();

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}

async function payment(suffix: string, amount: number, at: string, extra: { verified?: boolean; source?: string; status?: string; method?: string } = {}) {
  const [r] = await q<{ id: string }>(
    `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at, status, verification_status, verified_at, data_source)
     values ($1, $2, $3, $4, $5, ($6 || ':00+03')::timestamptz, $7, $8, $9, $10) returning id`,
    [
      tenant,
      customer,
      extra.method ?? "mpesa",
      ref(suffix),
      amount,
      at,
      extra.status ?? "successful",
      extra.verified ? "verified" : "unverified",
      extra.verified ? new Date() : null,
      extra.source ?? "manual",
    ],
  );
  return r.id;
}

type Line = { line?: number; reference: string; amount: number; date: string; details?: string };
type Report = {
  lines: { line: number; reference: string; outcome: string; note: string | null; payment_id: string | null; customer: string | null }[];
  missing: { payment_id: string; reference: string }[];
  verified: number;
  recorded_unmatched: number;
  from: string;
  to: string;
};

const reconcile = (c: pg.PoolClient, lines: Line[], apply = false, source = "mpesa_statement", t = tenant) =>
  c.query(`select public.reconcile_statement($1, $2, $3::jsonb, $4) as r`, [t, source, JSON.stringify(lines), apply]).then((r) => r.rows[0].r as Report);

const outcome = (r: Report, suffix: string) => r.lines.find((l) => l.reference === ref(suffix))?.outcome;

const ids: Record<string, string> = {};

beforeAll(async () => {
  owner = await createUser("rc-owner");
  finance = await createUser("rc-finance");
  support = await createUser("rc-support");
  otherOwner = await createUser("rc-other");
  tenant = await asUserCommit(owner, (c) => c.query(`select public.register_tenant('Reconcile ISP', $1) as id`, [`rc-${runId}`]).then((r) => r.rows[0].id as string));
  otherTenant = await asUserCommit(otherOwner, (c) => c.query(`select public.register_tenant('Other ISP', $1) as id`, [`rco-${runId}`]).then((r) => r.rows[0].id as string));
  await q(`update tenants set status = 'active', settings = settings || '{"payment_methods":["mpesa","bank_transfer","other"]}' where id = any($1)`, [[tenant, otherTenant]]);
  await q(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'finance'), ($1, $3, 'support_agent')`, [tenant, finance.id, support.id]);
  [{ id: customer }] = await q<{ id: string }>(
    `insert into customers (tenant_id, full_name, phone, status) values ($1, 'Grace Reconcile', '+254711000201', 'active') returning id`,
    [tenant],
  );
  [{ id: invoice }] = await q<{ id: string }>(
    `insert into invoices (tenant_id, customer_id, issue_date, due_date, subtotal, total, status) values ($1, $2, '2026-10-01', '2026-10-05', 2000, 2000, 'issued') returning id`,
    [tenant, customer],
  );
  await q(`insert into invoice_lines (tenant_id, invoice_id, description, category, quantity, unit_price, amount) values ($1, $2, 'Starter', 'subscription', 1, 2000, 2000)`, [tenant, invoice]);

  ids.match = await payment("A1", 2000, "2026-10-03 09:00");
  ids.mismatch = await payment("A2", 1500, "2026-10-04 09:00");
  ids.verified = await payment("A3", 1000, "2026-10-05 09:00", { verified: true });
  ids.sim = await payment("A4", 700, "2026-10-06 09:00", { source: "simulated" });
  ids.missing = await payment("A5", 1200, "2026-10-07 09:00");
  ids.outside = await payment("A6", 900, "2026-11-20 09:00");
  ids.bank = await payment("B1", 3000, "2026-10-03 10:00", { method: "bank_transfer" });
});

afterAll(async () => {
  await pool.end();
});

const statement: Line[] = [
  { line: 2, reference: ref("A1").toLowerCase(), amount: 2000, date: "2026-10-03", details: "Grace R" },
  { line: 3, reference: ref("A2"), amount: 1000, date: "2026-10-04" },
  { line: 4, reference: ref("A3"), amount: 1000, date: "2026-10-05" },
  { line: 5, reference: ref("A4"), amount: 700, date: "2026-10-06" },
  { line: 6, reference: ref("Z9"), amount: 2500, date: "2026-10-08", details: "Unknown payer 0722" },
  { line: 7, reference: ref("A1"), amount: 2000, date: "2026-10-03" },
  { line: 8, reference: "", amount: 50, date: "2026-10-09" },
];

describe("reconcile_statement preview", () => {
  it("classifies every line without changing anything", async () => {
    await asUser(finance, async (c) => {
      const r = await reconcile(c, statement);
      expect(outcome(r, "A1")).toBe("match");
      expect(outcome(r, "A2")).toBe("amount_mismatch");
      expect(outcome(r, "A3")).toBe("already_verified");
      expect(outcome(r, "A4")).toBe("simulated");
      expect(outcome(r, "Z9")).toBe("not_in_system");
      expect(r.lines.find((l) => l.line === 7)?.outcome).toBe("duplicate_line");
      expect(r.lines.find((l) => l.line === 8)?.outcome).toBe("invalid");
      expect(r.lines.find((l) => l.line === 2)?.customer).toBe("Grace Reconcile");
      expect(r.verified).toBe(0);
      const status = await c.query(`select verification_status from payments where id = $1`, [ids.match]);
      expect(status.rows[0].verification_status).toBe("unverified");
    });
  });

  it("lists unverified payments in the statement's dates that are missing from it", async () => {
    await asUser(finance, async (c) => {
      const r = await reconcile(c, statement);
      expect(r.from).toBe("2026-10-03");
      expect(r.to).toBe("2026-10-09");
      const missing = r.missing.map((m) => m.payment_id);
      expect(missing).toContain(ids.missing);
      expect(missing).not.toContain(ids.outside); // outside the statement dates
      expect(missing).not.toContain(ids.sim); // simulated never counts
      expect(missing).not.toContain(ids.bank); // other method
    });
  });

  it("matches bank references only against bank transfers", async () => {
    await asUser(finance, async (c) => {
      const asMpesa = await reconcile(c, [{ reference: ref("B1"), amount: 3000, date: "2026-10-03" }]);
      expect(asMpesa.lines[0].outcome).toBe("not_in_system");
      const asBank = await reconcile(c, [{ reference: ref("B1"), amount: 3000, date: "2026-10-03" }], false, "bank_statement");
      expect(asBank.lines[0].outcome).toBe("match");
    });
  });
});

describe("reconcile_statement apply", () => {
  it("verifies exact matches, allocates them and records unknown lines", async () => {
    await asUser(finance, async (c) => {
      const r = await reconcile(c, statement, true);
      expect(r.verified).toBe(1);
      expect(r.recorded_unmatched).toBe(1);
      expect(outcome(r, "A1")).toBe("verified");

      const pay = await c.query(`select verification_status, reconciliation_status, verified_by from payments where id = $1`, [ids.match]);
      expect(pay.rows[0]).toMatchObject({ verification_status: "verified", reconciliation_status: "matched", verified_by: finance.id });
      const inv = await c.query(`select status, amount_paid from invoices where id = $1`, [invoice]);
      expect(inv.rows[0].status).toBe("paid");

      const recs = await c.query(
        `select payment_id, result, statement_amount, statement_date::text as d, notes from payment_reconciliation_records where tenant_id = $1 order by result`,
        [tenant],
      );
      expect(recs.rows).toEqual([
        expect.objectContaining({ payment_id: ids.match, result: "matched", statement_amount: "2000.00", d: "2026-10-03" }),
        expect.objectContaining({ payment_id: null, result: "unmatched", statement_amount: "2500.00", notes: "Unknown payer 0722" }),
      ]);

      // Mismatched, simulated and already-verified payments are untouched.
      const others = await c.query(`select id, verification_status from payments where id = any($1)`, [[ids.mismatch, ids.sim]]);
      expect(others.rows.every((p) => p.verification_status === "unverified")).toBe(true);

      // Uploading the same statement again changes nothing.
      const again = await reconcile(c, statement, true);
      expect(again.verified).toBe(0);
      expect(again.recorded_unmatched).toBe(0);
      expect(outcome(again, "A1")).toBe("already_verified");
    });
  });

  it("links a line recorded as unknown once its payment is recorded", async () => {
    await asUser(finance, async (c) => {
      await reconcile(c, statement, true);
      const pay = await c.query(
        `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at, status, data_source, recorded_by)
         values ($1, $2, 'mpesa', $3, 2500, '2026-10-08 12:00+03', 'successful', 'manual', $4) returning id`,
        [tenant, customer, ref("Z9"), finance.id],
      );
      const again = await reconcile(c, statement, true);
      expect(outcome(again, "Z9")).toBe("verified");
      const recs = await c.query(
        `select payment_id, result from payment_reconciliation_records where tenant_id = $1 and statement_reference = $2`,
        [tenant, ref("Z9")],
      );
      expect(recs.rows).toEqual([{ payment_id: pay.rows[0].id, result: "matched" }]);
    });
  });

  it("writes an audit entry for the verification", async () => {
    await asUser(owner, async (c) => {
      await reconcile(c, statement, true);
      const audit = await c.query(
        `select count(*)::int as n from audit_logs where tenant_id = $1 and entity_type = 'payments' and entity_id = $2 and reason like 'Statement reconciliation%'`,
        [tenant, ids.match],
      );
      expect(audit.rows[0].n).toBeGreaterThan(0);
    });
  });
});

describe("reconcile_statement guards", () => {
  it("needs payments:reconcile", async () => {
    await asUser(support, async (c) => {
      const r = await tryQuery(c, `select public.reconcile_statement($1, 'mpesa_statement', '[]'::jsonb, false)`, [tenant]);
      expect(r.ok).toBe(false);
    });
  });

  it("cannot reach another ISP's payments", async () => {
    await asUser(otherOwner, async (c) => {
      const r = await tryQuery(c, `select public.reconcile_statement($1, 'mpesa_statement', $2::jsonb, true)`, [tenant, JSON.stringify(statement)]);
      expect(r.ok).toBe(false);
      const own = await reconcile(c, statement, false, "mpesa_statement", otherTenant);
      expect(own.lines.find((l) => l.reference === ref("A1"))?.outcome).toBe("not_in_system");
    });
  });

  it("rejects unknown statement types and oversized files", async () => {
    await asUser(owner, async (c) => {
      expect((await tryQuery(c, `select public.reconcile_statement($1, 'provider_query', '[]'::jsonb, true)`, [tenant])).ok).toBe(false);
      const big = JSON.stringify(Array.from({ length: 5001 }, (_, i) => ({ reference: `X${i}`, amount: 1, date: "2026-10-01" })));
      expect((await tryQuery(c, `select public.reconcile_statement($1, 'mpesa_statement', $2::jsonb, false)`, [tenant, big])).ok).toBe(false);
    });
  });
});
