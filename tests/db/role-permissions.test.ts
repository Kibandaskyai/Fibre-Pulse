/**
 * Role-based access inside one ISP, and FibrePulse platform staff access
 * (spec Part 2.4, Part 3, Part 6; Part 12 test 4 and "unauthorised access").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, count, pool, tryQuery } from "../helpers/db";
import { buildWorld, type World } from "../helpers/fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld();
}, 60_000);

afterAll(async () => {
  await pool.end();
});

const visible = (u: Parameters<typeof asUser>[0], table: string, tenantId: string) =>
  asUser(u, (c) => count(c, `select count(*) from public.${table} where tenant_id = $1`, [tenantId]));

describe("ISP roles", () => {
  it("finance sees payments and invoices but not routers or customer GPS", async () => {
    expect(await visible(w.financeA, "payments", w.a.tenantId)).toBe(1);
    expect(await visible(w.financeA, "invoices", w.a.tenantId)).toBe(1);
    expect(await visible(w.financeA, "routers", w.a.tenantId)).toBe(0);
    expect(await visible(w.financeA, "customer_locations", w.a.tenantId)).toBe(0);
  });

  it("network admin sees routers and GPS but not payments", async () => {
    expect(await visible(w.networkA, "routers", w.a.tenantId)).toBe(1);
    expect(await visible(w.networkA, "customer_locations", w.a.tenantId)).toBe(1);
    expect(await visible(w.networkA, "payments", w.a.tenantId)).toBe(0);
    expect(await visible(w.networkA, "invoices", w.a.tenantId)).toBe(0);
  });

  it("support agent sees customers and tickets, not payments or GPS", async () => {
    expect(await visible(w.supportA, "customers", w.a.tenantId)).toBe(1);
    expect(await visible(w.supportA, "support_tickets", w.a.tenantId)).toBe(1);
    expect(await visible(w.supportA, "payments", w.a.tenantId)).toBe(0);
    expect(await visible(w.supportA, "customer_locations", w.a.tenantId)).toBe(0);
  });

  it("technician sees only the customer and job they are assigned to", async () => {
    expect(await visible(w.technicianA, "installation_jobs", w.a.tenantId)).toBe(1);
    expect(await visible(w.technicianA, "customers", w.a.tenantId)).toBe(1);
    expect(await visible(w.technicianA, "customer_locations", w.a.tenantId)).toBe(1);
    expect(await visible(w.technicianA, "payments", w.a.tenantId)).toBe(0);
    expect(await visible(w.technicianA, "support_tickets", w.a.tenantId)).toBe(0);
  });

  it("technician loses sight of the customer once the job is completed", async () => {
    await asUser(w.technicianA, async (c) => {
      const r = await tryQuery(c, `update installation_jobs set status = 'completed', completed_at = now() where id = $1`, [
        w.a.ids.job,
      ]);
      expect(r.ok && r.rowCount).toBe(1);
      expect(await count(c, `select count(*) from customers`)).toBe(0);
    });
  });

  it("technician cannot reassign or reschedule a job", async () => {
    const r = await asUser(w.technicianA, (c) =>
      tryQuery(c, `update installation_jobs set scheduled_for = now() + interval '1 day' where id = $1`, [w.a.ids.job]),
    );
    expect(r.ok).toBe(false);
  });

  it("finance cannot create customers; support agent cannot record payments", async () => {
    const a = await asUser(w.financeA, (c) =>
      tryQuery(c, `insert into customers (tenant_id, full_name, phone) values ($1, 'New Person', '+254712345678')`, [w.a.tenantId]),
    );
    expect(a.ok).toBe(false);
    const b = await asUser(w.supportA, (c) =>
      tryQuery(
        c,
        `insert into payments (tenant_id, method, amount, transaction_at, data_source, recorded_by)
         values ($1, 'bank_transfer', 100, now(), 'manual', $2)`,
        [w.a.tenantId, w.supportA.id],
      ),
    );
    expect(b.ok).toBe(false);
  });

  it("nobody can read router credentials back, not even the owner", async () => {
    expect(await visible(w.a.owner, "router_credentials", w.a.tenantId)).toBe(0);
    expect(await visible(w.networkA, "router_credentials", w.a.tenantId)).toBe(0);
  });

  it("only staff managers can invite staff", async () => {
    const ok = await asUser(w.a.owner, (c) =>
      tryQuery(c, `insert into tenant_invitations (tenant_id, email, role, invited_by) values ($1, 'new.tech@example.test', 'technician', $2)`, [
        w.a.tenantId,
        w.a.owner.id,
      ]),
    );
    expect(ok.ok).toBe(true);
    const denied = await asUser(w.financeA, (c) =>
      tryQuery(c, `insert into tenant_invitations (tenant_id, email, role, invited_by) values ($1, 'x@example.test', 'finance', $2)`, [
        w.a.tenantId,
        w.financeA.id,
      ]),
    );
    expect(denied.ok).toBe(false);
  });

  it("ownership cannot be granted by invitation", async () => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(c, `insert into tenant_invitations (tenant_id, email, role, invited_by) values ($1, 'co@example.test', 'owner', $2)`, [
        w.a.tenantId,
        w.a.owner.id,
      ]),
    );
    expect(r.ok).toBe(false);
  });

  it("finance and owner can view their own platform invoices; network admin cannot", async () => {
    expect(await visible(w.a.owner, "platform_invoices", w.a.tenantId)).toBe(1);
    expect(await visible(w.financeA, "platform_invoices", w.a.tenantId)).toBe(1);
    expect(await visible(w.networkA, "platform_invoices", w.a.tenantId)).toBe(0);
  });

  it("ISP owners cannot write commercial agreements or fee records", async () => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(c, `update commercial_agreements set fee_rate = 0.01 where tenant_id = $1`, [w.a.tenantId]),
    );
    if (r.ok) expect(r.rowCount).toBe(0);
  });
});

describe("FibrePulse platform staff", () => {
  it("super admin sees the tenant list and commercial records", async () => {
    await asUser(w.superAdmin, async (c) => {
      expect(await count(c, `select count(*) from tenants where id in ($1, $2)`, [w.a.tenantId, w.b.tenantId])).toBe(2);
      expect(await count(c, `select count(*) from commercial_agreements where tenant_id = $1`, [w.a.tenantId])).toBe(1);
      expect(await count(c, `select count(*) from platform_fee_records where tenant_id = $1`, [w.a.tenantId])).toBe(1);
    });
  });

  it("super admin has no access to ISP customers, payments or network data", async () => {
    await asUser(w.superAdmin, async (c) => {
      for (const t of ["customers", "customer_locations", "payments", "invoices", "routers", "network_sessions", "support_tickets"]) {
        expect(await count(c, `select count(*) from ${t}`), t).toBe(0);
      }
    });
  });

  it("support admin sees nothing until an owner approves a support grant", async () => {
    expect(await visible(w.supportAdmin, "customers", w.a.tenantId)).toBe(0);

    const grantId = await asUser(w.supportAdmin, async (c) => {
      const r = await c.query(
        `insert into support_access_grants (tenant_id, granted_to, requested_reason) values ($1, $2, 'Investigating a router sync issue') returning id`,
        [w.a.tenantId, w.supportAdmin.id],
      );
      return r.rows[0].id as string;
    });
    expect(grantId).toBeTruthy();
  });

  it("an approved support grant gives read-only access to that ISP only, never payments", async () => {
    const g = await pool.query(
      `insert into support_access_grants (tenant_id, granted_to, requested_reason, approved_by, approved_at, expires_at)
       values ($1, $2, 'Investigating a router sync issue', $3, now(), now() + interval '2 hours') returning id`,
      [w.a.tenantId, w.supportAdmin.id, w.a.owner.id],
    );
    try {
      await asUser(w.supportAdmin, async (c) => {
        expect(await count(c, `select count(*) from customers where tenant_id = $1`, [w.a.tenantId])).toBe(1);
        expect(await count(c, `select count(*) from routers where tenant_id = $1`, [w.a.tenantId])).toBe(1);
        expect(await count(c, `select count(*) from customers where tenant_id = $1`, [w.b.tenantId])).toBe(0);
        expect(await count(c, `select count(*) from payments`)).toBe(0);
        expect(await count(c, `select count(*) from customer_locations`)).toBe(0);
        const write = await tryQuery(c, `update customers set notes = 'x' where tenant_id = $1`, [w.a.tenantId]);
        if (write.ok) expect(write.rowCount).toBe(0);
      });
    } finally {
      await pool.query(`update support_access_grants set revoked_at = now() where id = $1`, [g.rows[0].id]);
    }
    expect(await visible(w.supportAdmin, "customers", w.a.tenantId)).toBe(0);
  });

  it("support grants cannot last longer than 72 hours", async () => {
    const r = await pool
      .query(
        `insert into support_access_grants (tenant_id, granted_to, requested_reason, approved_by, approved_at, expires_at)
         values ($1, $2, 'Long-running access attempt', $3, now(), now() + interval '10 days')`,
        [w.a.tenantId, w.supportAdmin.id, w.a.owner.id],
      )
      .then(() => "inserted")
      .catch(() => "refused");
    expect(r).toBe("refused");
  });

  it("support admin cannot see commercial agreements or platform invoices", async () => {
    await asUser(w.supportAdmin, async (c) => {
      expect(await count(c, `select count(*) from commercial_agreements`)).toBe(0);
      expect(await count(c, `select count(*) from platform_invoices`)).toBe(0);
    });
  });

  it("ISP staff cannot make themselves platform admins", async () => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(c, `update profiles set platform_role = 'super_admin' where id = $1`, [w.a.owner.id]),
    );
    expect(r.ok).toBe(false);
  });

  it("ISP owners cannot activate or change the status of their own tenant", async () => {
    await pool.query(`update tenants set status = 'pending' where id = $1`, [w.b.tenantId]);
    try {
      const r = await asUser(w.b.owner, (c) => tryQuery(c, `update tenants set status = 'active' where id = $1`, [w.b.tenantId]));
      expect(r.ok).toBe(false);
      const ok = await asUser(w.b.owner, (c) => tryQuery(c, `update tenants set town = 'Ruaka' where id = $1`, [w.b.tenantId]));
      expect(ok.ok && ok.rowCount).toBe(1);
    } finally {
      await pool.query(`update tenants set status = 'active' where id = $1`, [w.b.tenantId]);
    }
  });

  it("super admin can activate a tenant and the change is audited", async () => {
    await pool.query(`update tenants set status = 'pending' where id = $1`, [w.b.tenantId]);
    await asUser(w.superAdmin, async (c) => {
      const r = await tryQuery(c, `update tenants set status = 'active' where id = $1`, [w.b.tenantId]);
      expect(r.ok && r.rowCount).toBe(1);
      const audit = await c.query(
        `select after_data->>'status' as status from audit_logs where entity_type = 'tenants' and entity_id = $1 order by id desc limit 1`,
        [w.b.tenantId],
      );
      expect(audit.rows[0]?.status).toBe("active");
    });
    await pool.query(`update tenants set status = 'active' where id = $1`, [w.b.tenantId]);
  });
});

describe("audit log", () => {
  it("records customer changes with the acting user, and only owners can read it", async () => {
    await asUser(w.a.owner, async (c) => {
      await c.query(`select set_config('fibrepulse.audit_reason', 'Corrected estate', true)`);
      await c.query(`update customers set estate = 'Zimmerman' where id = $1`, [w.a.ids.customer]);
      const r = await c.query(
        `select actor_id, reason, before_data->>'estate' as before, after_data->>'estate' as after
         from audit_logs where entity_type = 'customers' and entity_id = $1 order by id desc limit 1`,
        [w.a.ids.customer],
      );
      expect(r.rows[0]).toMatchObject({ actor_id: w.a.owner.id, reason: "Corrected estate", after: "Zimmerman" });
    });
    expect(await visible(w.financeA, "audit_logs", w.a.tenantId)).toBe(0);
  });

  it("audit entries cannot be edited or deleted by users", async () => {
    await asUser(w.a.owner, async (c) => {
      const u = await tryQuery(c, `update audit_logs set reason = 'tampered' where tenant_id = $1`, [w.a.tenantId]);
      const d = await tryQuery(c, `delete from audit_logs where tenant_id = $1`, [w.a.tenantId]);
      expect(u.ok).toBe(false);
      expect(d.ok).toBe(false);
    });
  });
});
