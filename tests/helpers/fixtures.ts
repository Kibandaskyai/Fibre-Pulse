/**
 * Two fictional ISPs with one row in every tenant table, plus users for every
 * role. Built once per test file. All names and numbers are fictional.
 */
import { asUserCommit, createUser, pool, runId, type TestUser } from "./db";

export type TenantFixture = {
  tenantId: string;
  owner: TestUser;
  ids: Record<string, string>;
};

export type World = {
  a: TenantFixture;
  b: TenantFixture;
  financeA: TestUser;
  networkA: TestUser;
  supportA: TestUser;
  technicianA: TestUser;
  outsider: TestUser;
  superAdmin: TestUser;
  supportAdmin: TestUser;
};

async function seedTenantRows(tenantId: string, owner: TestUser, label: string, technicianProfile?: TestUser) {
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0] as { id: string };
  const ids: Record<string, string> = {};
  const phoneTail = label === "a" ? "11" : "22";

  ids.customer = (
    await q(
      `insert into customers (tenant_id, full_name, phone, estate, town, county, status, created_by)
       values ($1, $2, $3, 'Roysambu', 'Nairobi', 'Nairobi', 'active', $4) returning id`,
      [tenantId, `Test Customer ${label}`, `+2547000000${phoneTail}`, owner.id],
    )
  ).id;
  await pool.query(
    `insert into customer_locations (tenant_id, customer_id, latitude, longitude) values ($1, $2, -1.2190, 36.8890)`,
    [tenantId, ids.customer],
  );
  ids.package = (
    await q(
      `insert into service_packages (tenant_id, name, download_mbps, upload_mbps, price, billing_period)
       values ($1, 'Home 10', 10, 10, 2500, 'monthly') returning id`,
      [tenantId],
    )
  ).id;
  ids.subscription = (
    await q(
      `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period)
       values ($1, $2, $3, 'active', now(), now() + interval '1 month', 2500, 'monthly') returning id`,
      [tenantId, ids.customer, ids.package],
    )
  ).id;
  ids.invoice = (
    await q(
      `insert into invoices (tenant_id, customer_id, subscription_id, due_date, subtotal, tax_amount, total, status)
       values ($1, $2, $3, current_date + 7, 2500, 0, 2500, 'issued') returning id`,
      [tenantId, ids.customer, ids.subscription],
    )
  ).id;
  ids.invoiceLine = (
    await q(
      `insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_price, amount)
       values ($1, $2, 'Home 10 monthly', 1, 2500, 2500) returning id`,
      [tenantId, ids.invoice],
    )
  ).id;
  ids.payment = (
    await q(
      `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at,
                             status, verification_status, data_source, recorded_by, description)
       values ($1, $2, 'bank_transfer', $3, 2500, now(), 'successful', 'unverified', 'manual', $4, 'Fixture payment') returning id`,
      [tenantId, ids.customer, `BNK${label.toUpperCase()}${runId}`, owner.id],
    )
  ).id;
  ids.allocation = (
    await q(
      `insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values ($1, $2, $3, 2500) returning id`,
      [tenantId, ids.payment, ids.invoice],
    )
  ).id;
  ids.reconciliation = (
    await q(
      `insert into payment_reconciliation_records (tenant_id, payment_id, statement_source, result)
       values ($1, $2, 'manual_review', 'matched') returning id`,
      [tenantId, ids.payment],
    )
  ).id;
  ids.connector = (
    await q(
      `insert into connector_agents (tenant_id, name, token_hash, token_prefix)
       values ($1, 'Main POP agent', $2, 'fpc_test') returning id`,
      [tenantId, `hash-${label}-${runId}`],
    )
  ).id;
  ids.router = (
    await q(
      `insert into routers (tenant_id, connector_agent_id, name, model, management_address, data_source)
       values ($1, $2, 'Core Router', 'CCR2004', '10.10.0.1', 'simulated') returning id`,
      [tenantId, ids.connector],
    )
  ).id;
  await pool.query(
    `insert into router_credentials (tenant_id, router_id, username, secret_ciphertext) values ($1, $2, 'fp-readonly', 'ciphertext')`,
    [tenantId, ids.router],
  );
  ids.routerInterface = (
    await q(
      `insert into router_interfaces (tenant_id, router_id, name, running, data_source) values ($1, $2, 'ether1', true, 'simulated') returning id`,
      [tenantId, ids.router],
    )
  ).id;
  ids.session = (
    await q(
      `insert into network_sessions (tenant_id, router_id, customer_id, session_type, username, started_at, data_source)
       values ($1, $2, $3, 'pppoe', 'cust-a', now(), 'simulated') returning id`,
      [tenantId, ids.router, ids.customer],
    )
  ).id;
  await pool.query(
    `insert into network_metrics (tenant_id, router_id, metric, value, recorded_at, data_source)
     values ($1, $2, 'cpu_load_pct', 12, now(), 'simulated')`,
    [tenantId, ids.router],
  );
  ids.alert = (
    await q(
      `insert into network_alerts (tenant_id, router_id, severity, alert_type, title, data_source)
       values ($1, $2, 'warning', 'high_cpu', 'High CPU', 'simulated') returning id`,
      [tenantId, ids.router],
    )
  ).id;
  ids.ticket = (
    await q(
      `insert into support_tickets (tenant_id, customer_id, category, subject, created_by)
       values ($1, $2, 'slow_internet', 'Slow speeds in the evening', $3) returning id`,
      [tenantId, ids.customer, owner.id],
    )
  ).id;
  if (technicianProfile) {
    ids.technician = (
      // Members with the technician role get a technician row automatically.
      await q(
        `insert into technicians (tenant_id, profile_id, zone) values ($1, $2, 'Roysambu')
         on conflict (tenant_id, profile_id) do update set zone = excluded.zone returning id`,
        [
        tenantId,
        technicianProfile.id,
      ])
    ).id;
  }
  ids.job = (
    await q(
      `insert into installation_jobs (tenant_id, customer_id, ticket_id, technician_id, job_type, status, created_by)
       values ($1, $2, $3, $4, 'fault_investigation', 'scheduled', $5) returning id`,
      [tenantId, ids.customer, ids.ticket, ids.technician ?? null, owner.id],
    )
  ).id;
  ids.ticketEvent = (await q(`select id from ticket_events where ticket_id = $1 order by created_at limit 1`, [ids.ticket])).id;
  ids.jobEvent = (await q(`select id from job_events where job_id = $1 order by created_at limit 1`, [ids.job])).id;
  ids.notificationPreference = (
    await q(`insert into notification_preferences (tenant_id, profile_id, type, email) values ($1, $2, 'payment_failure', true) returning id`, [tenantId, owner.id])
  ).id;
  ids.notification = (
    await q(
      `insert into notifications (tenant_id, recipient_id, type, title) values ($1, $2, 'system', 'Welcome') returning id`,
      [tenantId, owner.id],
    )
  ).id;
  ids.platformInvoice = (
    await q(
      `insert into platform_invoices (tenant_id, invoice_number, period_start, period_end, subtotal, total, status)
       values ($1, $2, '2026-10-01', '2026-10-31', 68.75, 68.75, 'issued') returning id`,
      [tenantId, `FPI-${label}-${runId}`],
    )
  ).id;
  const agreement = await q(`select id from commercial_agreements where tenant_id = $1`, [tenantId]);
  ids.agreement = agreement.id;
  ids.feeRecord = (
    await q(
      `insert into platform_fee_records (tenant_id, agreement_id, period_start, period_end, eligible_amount, fee_rate, fee_amount)
       values ($1, $2, '2026-10-01', '2026-10-31', 2500, 0.0275, 68.75) returning id`,
      [tenantId, ids.agreement],
    )
  ).id;
  return ids;
}

async function addMember(tenantId: string, user: TestUser, role: string) {
  await pool.query(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, $3)`, [tenantId, user.id, role]);
}

export async function buildWorld(): Promise<World> {
  const ownerA = await createUser("owner-a");
  const ownerB = await createUser("owner-b");
  const financeA = await createUser("finance-a");
  const networkA = await createUser("network-a");
  const supportA = await createUser("support-a");
  const technicianA = await createUser("technician-a");
  const outsider = await createUser("outsider");
  const superAdmin = await createUser("super-admin", { platformRole: "super_admin" });
  const supportAdmin = await createUser("support-admin", { platformRole: "support_admin" });

  const register = (u: TestUser, name: string, slug: string) =>
    asUserCommit(u, async (c) => {
      const r = await c.query(`select public.register_tenant($1, $2, 'Nairobi', 'Nairobi', null, $3) as id`, [
        name,
        slug,
        name + " Owner",
      ]);
      return r.rows[0].id as string;
    });

  const tenantA = await register(ownerA, "Kilimani Fibre Test", `kilimani-${runId}`);
  const tenantB = await register(ownerB, "Ruaka Net Test", `ruaka-${runId}`);
  // New ISPs accept M-Pesa only (pilot rule); these generic test ISPs accept
  // every method so the bank-transfer paths stay covered.
  await pool.query(
    `update tenants set status = 'active', settings = settings || '{"payment_methods":["mpesa","bank_transfer","other"]}'::jsonb where id in ($1, $2)`,
    [tenantA, tenantB],
  );

  await addMember(tenantA, financeA, "finance");
  await addMember(tenantA, networkA, "network_admin");
  await addMember(tenantA, supportA, "support_agent");
  await addMember(tenantA, technicianA, "technician");

  const idsA = await seedTenantRows(tenantA, ownerA, "a", technicianA);
  const idsB = await seedTenantRows(tenantB, ownerB, "b");

  return {
    a: { tenantId: tenantA, owner: ownerA, ids: idsA },
    b: { tenantId: tenantB, owner: ownerB, ids: idsB },
    financeA,
    networkA,
    supportA,
    technicianA,
    outsider,
    superAdmin,
    supportAdmin,
  };
}

/** Every tenant-owned table and its primary key column. */
export const TENANT_TABLES: { table: string; key: string; fixtureId: string }[] = [
  { table: "customers", key: "id", fixtureId: "customer" },
  { table: "customer_locations", key: "customer_id", fixtureId: "customer" },
  { table: "service_packages", key: "id", fixtureId: "package" },
  { table: "subscriptions", key: "id", fixtureId: "subscription" },
  { table: "invoices", key: "id", fixtureId: "invoice" },
  { table: "invoice_lines", key: "id", fixtureId: "invoiceLine" },
  { table: "payments", key: "id", fixtureId: "payment" },
  { table: "payment_allocations", key: "id", fixtureId: "allocation" },
  { table: "payment_reconciliation_records", key: "id", fixtureId: "reconciliation" },
  { table: "connector_agents", key: "id", fixtureId: "connector" },
  { table: "routers", key: "id", fixtureId: "router" },
  { table: "router_credentials", key: "router_id", fixtureId: "router" },
  { table: "router_interfaces", key: "id", fixtureId: "routerInterface" },
  { table: "network_sessions", key: "id", fixtureId: "session" },
  { table: "network_alerts", key: "id", fixtureId: "alert" },
  { table: "support_tickets", key: "id", fixtureId: "ticket" },
  { table: "installation_jobs", key: "id", fixtureId: "job" },
  { table: "notifications", key: "id", fixtureId: "notification" },
  { table: "ticket_events", key: "id", fixtureId: "ticketEvent" },
  { table: "job_events", key: "id", fixtureId: "jobEvent" },
  { table: "notification_preferences", key: "id", fixtureId: "notificationPreference" },
  { table: "platform_invoices", key: "id", fixtureId: "platformInvoice" },
  { table: "commercial_agreements", key: "id", fixtureId: "agreement" },
  { table: "platform_fee_records", key: "id", fixtureId: "feeRecord" },
];
