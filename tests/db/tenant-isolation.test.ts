/**
 * Cross-tenant isolation (spec Part 6 and Part 12, test 3).
 *
 * For every tenant-owned table, the owner of ISP A must not be able to read,
 * update, delete or insert ISP B rows, and anonymous visitors see nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, count, pool, tryQuery } from "../helpers/db";
import { buildWorld, TENANT_TABLES, type World } from "../helpers/fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld();
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe("tenant isolation", () => {
  it.each(TENANT_TABLES)("owner of ISP A cannot read ISP B rows in $table", async ({ table }) => {
    const n = await asUser(w.a.owner, (c) => count(c, `select count(*) from public.${table} where tenant_id = $1`, [w.b.tenantId]));
    expect(n).toBe(0);
  });

  it.each(TENANT_TABLES.filter((t) => t.table !== "router_credentials"))(
    "owner of ISP A can read their own rows in $table",
    async ({ table, key, fixtureId }) => {
      const n = await asUser(w.a.owner, (c) =>
        count(c, `select count(*) from public.${table} where ${key} = $1`, [w.a.ids[fixtureId]]),
      );
      expect(n).toBe(1);
    },
  );

  it.each(TENANT_TABLES)("owner of ISP A cannot update ISP B rows in $table", async ({ table, key, fixtureId }) => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(c, `update public.${table} set tenant_id = tenant_id where ${key} = $1`, [w.b.ids[fixtureId]]),
    );
    // Either the row is invisible (0 rows) or the write is refused outright.
    if (r.ok) expect(r.rowCount).toBe(0);
  });

  it.each(TENANT_TABLES)("owner of ISP A cannot delete ISP B rows in $table", async ({ table, key, fixtureId }) => {
    const r = await asUser(w.a.owner, (c) => tryQuery(c, `delete from public.${table} where ${key} = $1`, [w.b.ids[fixtureId]]));
    if (r.ok) expect(r.rowCount).toBe(0);
    const still = await pool.query(`select count(*) from public.${table} where ${key} = $1`, [w.b.ids[fixtureId]]);
    expect(Number(still.rows[0].count)).toBe(1);
  });

  it("owner of ISP A cannot insert a customer into ISP B", async () => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(c, `insert into customers (tenant_id, full_name, phone) values ($1, 'Intruder', '+254711111111')`, [w.b.tenantId]),
    );
    expect(r.ok).toBe(false);
  });

  it("a row in ISP A cannot reference a customer in ISP B (composite foreign key)", async () => {
    const r = await asUser(w.a.owner, (c) =>
      tryQuery(
        c,
        `insert into support_tickets (tenant_id, customer_id, category, subject, created_by)
         values ($1, $2, 'general_enquiry', 'Cross-tenant reference', $3)`,
        [w.a.tenantId, w.b.ids.customer, w.a.owner.id],
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("a user with no membership sees no tenant data", async () => {
    await asUser(w.outsider, async (c) => {
      for (const { table } of TENANT_TABLES) {
        expect(await count(c, `select count(*) from public.${table}`), table).toBe(0);
      }
      expect(await count(c, `select count(*) from public.tenants`)).toBe(0);
    });
  });

  it("anonymous visitors cannot read any table", async () => {
    await asUser(null, async (c) => {
      for (const table of ["tenants", "profiles", "customers", "payments", "routers", "audit_logs"]) {
        const r = await tryQuery(c, `select 1 from public.${table} limit 1`);
        expect(r.ok, table).toBe(false);
      }
    });
  });

  it("members of a suspended ISP lose access", async () => {
    await pool.query(`update tenants set status = 'suspended' where id = $1`, [w.b.tenantId]);
    try {
      const n = await asUser(w.b.owner, (c) => count(c, `select count(*) from customers`));
      expect(n).toBe(0);
    } finally {
      await pool.query(`update tenants set status = 'active' where id = $1`, [w.b.tenantId]);
    }
  });

  it("every public table has row level security enabled", async () => {
    const r = await pool.query(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`);
    expect(r.rows.map((x) => x.tablename)).toEqual([]);
  });
});
