/**
 * Tenant registration, staff invitations, ownership safety, and the database
 * guards that protect money and commercial terms
 * (spec Part 2.3, Part 4 Module 4; Part 12 tests 2, 8, 9, 11).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, TENANT_ROLES } from "@/lib/auth/permissions";
import { asUser, asUserCommit, count, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";
import { buildWorld, type World } from "../helpers/fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld();
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe("tenant registration", () => {
  it("creates a pending ISP, an owner membership and a draft 2.75% gross agreement", async () => {
    const u = await createUser("new-isp-owner");
    const tenantId = await asUserCommit(u, async (c) => {
      const r = await c.query(`select public.register_tenant('Syokimau Fibre', $1, 'Machakos', 'Syokimau', '+254722000111', 'Wanjiru Test') as id`, [
        `syokimau-${runId}`,
      ]);
      return r.rows[0].id as string;
    });
    const t = await pool.query(`select status, slug, timezone, currency from tenants where id = $1`, [tenantId]);
    expect(t.rows[0]).toMatchObject({ status: "pending", slug: `syokimau-${runId}`, timezone: "Africa/Nairobi", currency: "KES" });
    const m = await pool.query(`select role, status from tenant_members where tenant_id = $1 and profile_id = $2`, [tenantId, u.id]);
    expect(m.rows[0]).toMatchObject({ role: "owner", status: "active" });
    const a = await pool.query(`select status, fee_rate, fee_basis, excluded_categories from commercial_agreements where tenant_id = $1`, [tenantId]);
    expect(a.rows[0]).toMatchObject({ status: "draft", fee_rate: "0.0275", fee_basis: "gross" });
    expect(a.rows[0].excluded_categories).toEqual("{installation,equipment,other}");
    const p = await pool.query(`select full_name from profiles where id = $1`, [u.id]);
    expect(p.rows[0].full_name).toBe("new-isp-owner"); // existing name is kept
  });

  it("the new owner can use the ISP while it is pending activation", async () => {
    const u = await createUser("pending-owner");
    const tenantId = await asUserCommit(u, async (c) => (await c.query(`select public.register_tenant('Pending ISP', $1) as id`, [`pending-${runId}`])).rows[0].id);
    const perms = await asUser(u, async (c) => (await c.query(`select public.my_permissions($1) as p`, [tenantId])).rows[0].p as string[]);
    expect(perms).toContain("staff:manage");
  });

  it("rejects a duplicate workspace address", async () => {
    const u = await createUser("dup-owner");
    const r = await asUser(u, (c) => tryQuery(c, `select public.register_tenant('Copy', $1)`, [`kilimani-${runId}`]));
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid workspace address", async () => {
    const u = await createUser("bad-slug-owner");
    const r = await asUser(u, (c) => tryQuery(c, `select public.register_tenant('Bad', 'Bad Slug!')`));
    expect(r.ok).toBe(false);
  });

  it("anonymous visitors cannot register an ISP", async () => {
    const r = await asUser(null, (c) => tryQuery(c, `select public.register_tenant('Anon ISP', $1)`, [`anon-${runId}`]));
    expect(r.ok).toBe(false);
  });

  it("users cannot insert tenants or memberships directly", async () => {
    await asUser(w.outsider, async (c) => {
      const t = await tryQuery(c, `insert into tenants (name, slug) values ('Direct', $1)`, [`direct-${runId}`]);
      expect(t.ok).toBe(false);
      const m = await tryQuery(c, `insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'owner')`, [
        w.a.tenantId,
        w.outsider.id,
      ]);
      expect(m.ok).toBe(false);
    });
  });
});

describe("staff invitations", () => {
  async function invite(email: string, role: string) {
    return asUserCommit(w.a.owner, async (c) => {
      const r = await c.query(
        `insert into tenant_invitations (tenant_id, email, role, invited_by) values ($1, $2, $3, $4) returning id`,
        [w.a.tenantId, email, role, w.a.owner.id],
      );
      return r.rows[0].id as string;
    });
  }

  it("the invited person can see and accept their invitation and gets that role", async () => {
    const invitee = await createUser("invitee");
    const invId = await invite(invitee.email, "finance");
    await asUser(invitee, async (c) => {
      expect(await count(c, `select count(*) from tenant_invitations where id = $1`, [invId])).toBe(1);
      const r = await c.query(`select public.accept_invitation($1) as t`, [invId]);
      expect(r.rows[0].t).toBe(w.a.tenantId);
      expect(await count(c, `select count(*) from payments where tenant_id = $1`, [w.a.tenantId])).toBe(1);
      expect(await count(c, `select count(*) from routers where tenant_id = $1`, [w.a.tenantId])).toBe(0);
    });
  });

  it("accepting a technician invitation also creates the technician record", async () => {
    const tech = await createUser("invited-tech");
    const invId = await invite(tech.email, "technician");
    await asUser(tech, async (c) => {
      await c.query(`select public.accept_invitation($1)`, [invId]);
      expect(await count(c, `select count(*) from technicians where profile_id = $1`, [tech.id])).toBe(1);
    });
  });

  it("someone else cannot accept an invitation meant for another email", async () => {
    const invitee = await createUser("intended");
    const invId = await invite(invitee.email, "support_agent");
    const r = await asUser(w.outsider, (c) => tryQuery(c, `select public.accept_invitation($1)`, [invId]));
    expect(r.ok).toBe(false);
  });

  it("an unconfirmed email cannot accept an invitation", async () => {
    const unconfirmed = await createUser("unconfirmed", { confirmed: false });
    const invId = await invite(unconfirmed.email, "support_agent");
    const r = await asUser(unconfirmed, (c) => tryQuery(c, `select public.accept_invitation($1)`, [invId]));
    expect(r.ok).toBe(false);
  });

  it("a revoked invitation cannot be accepted", async () => {
    const invitee = await createUser("revoked");
    const invId = await invite(invitee.email, "support_agent");
    await pool.query(`update tenant_invitations set revoked_at = now() where id = $1`, [invId]);
    const r = await asUser(invitee, (c) => tryQuery(c, `select public.accept_invitation($1)`, [invId]));
    expect(r.ok).toBe(false);
  });
});

describe("ownership safety", () => {
  it("the last owner cannot be removed or demoted", async () => {
    // Another owner of A does not exist, so the guard must refuse.
    const r = await pool
      .query(`update tenant_members set role = 'finance' where tenant_id = $1 and profile_id = $2`, [w.a.tenantId, w.a.owner.id])
      .then(() => "changed")
      .catch(() => "refused");
    expect(r).toBe("refused");
  });

  it("an owner cannot change their own role", async () => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(c, `update tenant_members set role = 'finance' where tenant_id = $1 and profile_id = $2`, [w.a.tenantId, w.a.owner.id]),
    );
    expect(r.ok).toBe(false);
  });

  it("an owner can change another member's role, and finance cannot", async () => {
    const ok = await asUser(w.a.owner, (c) =>
      tryQuery(c, `update tenant_members set role = 'support_agent' where tenant_id = $1 and profile_id = $2`, [
        w.a.tenantId,
        w.financeA.id,
      ]),
    );
    expect(ok.ok && ok.rowCount).toBe(1);
    const denied = await asUser(w.financeA, (c) =>
      tryQuery(c, `update tenant_members set role = 'owner' where tenant_id = $1 and profile_id = $2`, [w.a.tenantId, w.supportA.id]),
    );
    if (denied.ok) expect(denied.rowCount).toBe(0);
  });
});

describe("payment guards", () => {
  const manualPayment = (u: TestUser, extra: Partial<Record<string, unknown>> = {}) => ({
    sql: `insert into payments (tenant_id, method, provider_reference, amount, transaction_at, data_source, recorded_by, verification_status, status)
          values ($1, $2, $3, $4, now(), $5, $6, $7, $8)`,
    params: [
      w.a.tenantId,
      extra.method ?? "bank_transfer",
      extra.reference ?? `REF${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      extra.amount ?? 1500,
      extra.source ?? "manual",
      u.id,
      extra.verification ?? "unverified",
      extra.status ?? "successful",
    ],
  });

  it("finance can record a manual, unverified payment", async () => {
    const p = manualPayment(w.financeA);
    const r = await asUser(w.financeA, (c) => tryQuery(c, p.sql, p.params));
    expect(r.ok).toBe(true);
  });

  it("people cannot record a payment as already verified, or as a provider payment", async () => {
    const verified = manualPayment(w.financeA, { verification: "verified" });
    expect((await asUser(w.financeA, (c) => tryQuery(c, verified.sql, verified.params))).ok).toBe(false);
    const provider = manualPayment(w.financeA, { source: "provider", method: "mpesa" });
    expect((await asUser(w.financeA, (c) => tryQuery(c, provider.sql, provider.params))).ok).toBe(false);
  });

  it("duplicate transaction references are rejected", async () => {
    const r = await asUser(w.financeA, async (c) => {
      const first = manualPayment(w.financeA, { reference: `DUP${runId}` });
      await c.query(first.sql, first.params);
      return tryQuery(c, first.sql, first.params);
    });
    expect(r.ok).toBe(false);
  });

  it("a payment's amount and reference cannot be edited after recording", async () => {
    // Browser roles have no update path at all, and the trigger guards even
    // the database owner and the SECURITY DEFINER functions.
    const r = await asUser(w.a.owner, (c) => tryQuery(c, `update payments set amount = 1 where id = $1`, [w.a.ids.payment]));
    expect(r.ok && r.rowCount).toBe(0);
    const asOwner = await pool
      .query(`update payments set provider_reference = 'CHANGED1' where id = $1`, [w.a.ids.payment])
      .then(() => "updated")
      .catch(() => "refused");
    expect(asOwner).toBe("refused");
  });

  it("a payment cannot be verified by a direct update, only through verify_payment", async () => {
    const direct = await asUser(w.financeA, (c) =>
      tryQuery(c, `update payments set verification_status = 'verified', verified_by = $2, verified_at = now() where id = $1`, [
        w.a.ids.payment,
        w.financeA.id,
      ]),
    );
    expect(direct.ok && direct.rowCount).toBe(0);
    const viaFunction = await asUser(w.financeA, (c) =>
      tryQuery(c, `select public.verify_payment($1, 'bank_statement', 'STMT-1', null)`, [w.a.ids.payment]),
    );
    expect(viaFunction.ok).toBe(true);
  });

  it("simulated payments can never be marked verified", async () => {
    const r = await pool
      .query(
        `insert into payments (tenant_id, method, amount, transaction_at, data_source, verification_status, verified_at)
         values ($1, 'mpesa', 100, now(), 'simulated', 'verified', now())`,
        [w.a.tenantId],
      )
      .then(() => "inserted")
      .catch(() => "refused");
    expect(r).toBe("refused");
  });

  it("allocations cannot exceed the payment amount", async () => {
    const r = await pool
      .query(`insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values ($1, $2, $3, 1)`, [
        w.a.tenantId,
        w.a.ids.payment,
        w.a.ids.invoice,
      ])
      .then(() => "inserted")
      .catch(() => "refused");
    expect(r).toBe("refused"); // 2,500 already allocated from a 2,500 payment (and unique per invoice)
  });
});

describe("commercial agreement guards", () => {
  it("signed terms are frozen; a new rate needs a new version", async () => {
    const t = w.b.tenantId;
    await pool.query(
      `update commercial_agreements set status = 'active', signed_at = now(), signed_by_name = 'Test Director', effective_from = '2026-01-01' where tenant_id = $1 and version = 1`,
      [t],
    );
    const change = await pool
      .query(`update commercial_agreements set fee_rate = 0.0250 where tenant_id = $1 and version = 1`, [t])
      .then(() => "changed")
      .catch(() => "refused");
    expect(change).toBe("refused");
  });

  it("two in-force agreements cannot overlap in time", async () => {
    const r = await pool
      .query(
        `insert into commercial_agreements (tenant_id, version, status, fee_rate, effective_from, signed_at)
         values ($1, 2, 'active', 0.0250, '2026-06-01', now())`,
        [w.b.tenantId],
      )
      .then(() => "inserted")
      .catch(() => "refused");
    expect(r).toBe("refused");
  });

  it("a billing period can only be charged once", async () => {
    const r = await pool
      .query(
        `insert into platform_fee_records (tenant_id, agreement_id, period_start, period_end, eligible_amount, fee_rate, fee_amount)
         values ($1, $2, '2026-10-01', '2026-10-31', 2500, 0.0275, 68.75)`,
        [w.a.tenantId, w.a.ids.agreement],
      )
      .then(() => "inserted")
      .catch(() => "refused");
    expect(r).toBe("refused");
  });

  it("fee amount must equal eligible amount times rate", async () => {
    const r = await pool
      .query(
        `insert into platform_fee_records (tenant_id, agreement_id, period_start, period_end, eligible_amount, fee_rate, fee_amount)
         values ($1, $2, '2026-11-01', '2026-11-30', 1000000, 0.0275, 30000)`,
        [w.a.tenantId, w.a.ids.agreement],
      )
      .then(() => "inserted")
      .catch(() => "refused");
    expect(r).toBe("refused");
  });
});

describe("permission matrix", () => {
  it("database role_permissions matches src/lib/auth/permissions.ts exactly", async () => {
    const r = await pool.query(`select role::text, permission from private.role_permissions order by role, permission`);
    const db: Record<string, string[]> = {};
    for (const row of r.rows) (db[row.role] ??= []).push(row.permission);
    for (const role of TENANT_ROLES) {
      expect([...(db[role] ?? [])].sort(), role).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
    expect(Object.keys(db).sort()).toEqual([...TENANT_ROLES].sort());
  });
});

describe("document numbers", () => {
  it("customers get sequential per-ISP numbers with the ISP prefix", async () => {
    await asUser(w.a.owner, async (c) => {
      const r = await c.query(
        `insert into customers (tenant_id, full_name, phone) values ($1, 'Numbered Customer', '+254733000001') returning customer_number`,
        [w.a.tenantId],
      );
      expect(r.rows[0].customer_number).toMatch(/^FP-\d{6}$/);
    });
  });

  it("the same phone number cannot be registered twice in one ISP", async () => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(c, `insert into customers (tenant_id, full_name, phone) values ($1, 'Duplicate Phone', '+254700000011')`, [w.a.tenantId]),
    );
    expect(r.ok).toBe(false);
  });
});
