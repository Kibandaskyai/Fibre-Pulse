/**
 * Phase 7 security sweep. Instead of testing tables one by one, these tests
 * read the database catalogue so a table or function added later is checked
 * automatically.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, pool } from "../helpers/db";
import { buildWorld, type World } from "../helpers/fixtures";

let w: World;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}

beforeAll(async () => {
  w = await buildWorld();
});

afterAll(async () => {
  await pool.end();
});

/** Public tables that carry a tenant_id column. */
const tenantTables = () =>
  q<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
     order by 1`,
  ).then((r) => r.map((x) => x.table_name));

describe("tenant isolation across every table", () => {
  it("an ISP owner never sees another ISP's row in any tenant table", async () => {
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThan(30);
    const leaks: string[] = [];
    await asUser(w.a.owner, async (c) => {
      for (const t of tables) {
        const { rows } = await c.query(`select count(*)::int as n from public.${t} where tenant_id is distinct from $1`, [w.a.tenantId]);
        if (rows[0].n > 0) leaks.push(`${t}: ${rows[0].n}`);
      }
    });
    expect(leaks).toEqual([]);
  });

  it("someone with no ISP sees no tenant rows at all", async () => {
    const tables = await tenantTables();
    const leaks: string[] = [];
    await asUser(w.outsider, async (c) => {
      for (const t of tables) {
        const { rows } = await c.query(`select count(*)::int as n from public.${t}`);
        if (rows[0].n > 0) leaks.push(`${t}: ${rows[0].n}`);
      }
    });
    expect(leaks).toEqual([]);
  });

  it("FibrePulse staff see no ISP customer, payment or network rows without an approved grant", async () => {
    const sensitive = [
      "customers", "customer_locations", "subscriptions", "invoices", "invoice_lines", "payments", "payment_allocations",
      "payment_reconciliation_records", "routers", "router_credentials", "network_sessions", "network_metrics",
      "support_tickets", "installation_jobs",
    ];
    for (const staff of [w.superAdmin, w.supportAdmin]) {
      await asUser(staff, async (c) => {
        for (const t of sensitive) {
          const { rows } = await c.query(`select count(*)::int as n from public.${t}`);
          expect(rows[0].n, `${t} visible to platform staff`).toBe(0);
        }
      });
    }
  });
});

describe("database permissions", () => {
  it("every table in public has row level security on", async () => {
    const off = await q(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`);
    expect(off).toEqual([]);
  });

  it("the public cannot write to any table", async () => {
    const writable = await q(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon' and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`,
    );
    expect(writable).toEqual([]);
  });

  it("the public can call only the connector functions (which check their own token) and the hotspot buying page", async () => {
    const fns = await q<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`,
    );
    expect(fns.map((f) => f.proname)).toEqual([
      "connector_command_result",
      "connector_ingest",
      "connector_sync",
      // People buying WiFi are not signed in. These show plan prices, start an
      // unpaid purchase (rate limited) and report its status; payment is only
      // confirmed by the server with the service role (see hotspot.test.ts).
      "hotspot_portal",
      "hotspot_portal_buy",
      "hotspot_portal_simulate_payment",
      "hotspot_portal_status",
    ]);
  });

  it("the private schema is out of reach of the public API", async () => {
    const [r] = await q<{ anon: boolean }>(`select has_schema_privilege('anon', 'private', 'usage') as anon`);
    expect(r.anon).toBe(false);
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const loose = await q<{ fn: string }>(
      `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(loose).toEqual([]);
  });

  it("router passwords cannot be read back by anyone signed in", async () => {
    await asUser(w.a.owner, async (c) => {
      const { rows } = await c.query(`select count(*)::int as n from public.router_credentials`);
      expect(rows[0].n).toBe(0);
    });
  });
});
