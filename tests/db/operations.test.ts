/**
 * Phase 5: ticket and job rules, history, notifications and preferences.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, asUserCommit, count, createUser, pool, runId, tryQuery, type TestUser } from "../helpers/db";

let owner: TestUser;
let support: TestUser;
let support2: TestUser;
let finance: TestUser;
let tech: TestUser;
let tech2: TestUser;
let outsider: TestUser;
let tenant: string;
let customer: string;
let techId: string;
let tech2Id: string;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows as T[];
}
const inbox = (user: TestUser, type?: string) =>
  q<{ type: string; title: string; body: string; link: string }>(
    `select type, title, body, link from notifications where recipient_id = $1 and tenant_id = $2 ${type ? "and type = $3" : ""} order by created_at`,
    type ? [user.id, tenant, type] : [user.id, tenant],
  );

async function newTicket(by: TestUser, over: Record<string, unknown> = {}) {
  const t = { category: "no_internet", priority: "high", subject: `No internet ${Math.random().toString(36).slice(2, 7)}`, ...over };
  return asUserCommit(by, (c) =>
    c
      .query(
        `insert into support_tickets (tenant_id, customer_id, category, priority, subject, created_by, assigned_to)
         values ($1, $2, $3, $4, $5, $6, $7) returning id, ticket_number, status`,
        [tenant, customer, t.category, t.priority, t.subject, by.id, (t as { assigned_to?: string }).assigned_to ?? null],
      )
      .then((r) => r.rows[0] as { id: string; ticket_number: string; status: string }),
  );
}

beforeAll(async () => {
  owner = await createUser("ops-owner");
  support = await createUser("ops-support");
  support2 = await createUser("ops-support2");
  finance = await createUser("ops-finance");
  tech = await createUser("ops-tech");
  tech2 = await createUser("ops-tech2");
  outsider = await createUser("ops-outsider");
  tenant = await asUserCommit(owner, (c) => c.query(`select public.register_tenant('Ops ISP', $1) as id`, [`ops-${runId}`]).then((r) => r.rows[0].id));
  await q(`update tenants set status = 'active' where id = $1`, [tenant]);
  await q(
    `insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'support_agent'), ($1, $3, 'support_agent'), ($1, $4, 'finance'), ($1, $5, 'technician'), ($1, $6, 'technician')`,
    [tenant, support.id, support2.id, finance.id, tech.id, tech2.id],
  );
  [{ id: customer }] = await q<{ id: string }>(
    `insert into customers (tenant_id, full_name, phone, status) values ($1, 'Amina Otieno', '+254711000901', 'active') returning id`,
    [tenant],
  );
  [{ id: techId }] = await q<{ id: string }>(`select id from technicians where tenant_id = $1 and profile_id = $2`, [tenant, tech.id]);
  [{ id: tech2Id }] = await q<{ id: string }>(`select id from technicians where tenant_id = $1 and profile_id = $2`, [tenant, tech2.id]);
});

afterAll(async () => {
  await pool.end();
});

describe("technicians", () => {
  it("are created for members with the technician role and deactivated when the role changes", async () => {
    expect(techId).toBeTruthy();
    const extra = await createUser("ops-tech3");
    await q(`insert into tenant_members (tenant_id, profile_id, role) values ($1, $2, 'technician')`, [tenant, extra.id]);
    expect((await q(`select active from technicians where tenant_id = $1 and profile_id = $2`, [tenant, extra.id]))[0]).toMatchObject({ active: true });
    await q(`update tenant_members set role = 'support_agent' where tenant_id = $1 and profile_id = $2`, [tenant, extra.id]);
    expect((await q(`select active from technicians where tenant_id = $1 and profile_id = $2`, [tenant, extra.id]))[0]).toMatchObject({ active: false });
  });

  it("directory lists active technicians with open job counts, only for staff who plan work", async () => {
    const rows = await asUser(support, (c) => c.query(`select * from technician_directory($1)`, [tenant]).then((r) => r.rows));
    expect(rows.map((r) => r.profile_id)).toEqual(expect.arrayContaining([tech.id, tech2.id]));
    expect(rows.every((r) => !("email" in r))).toBe(true);
    const none = await asUser(finance, (c) => c.query(`select * from technician_directory($1)`, [tenant]).then((r) => r.rows));
    expect(none).toEqual([]);
    const staff = await asUser(outsider, (c) => c.query(`select * from staff_directory($1)`, [tenant]).then((r) => r.rows));
    expect(staff).toEqual([]);
  });
});

describe("support tickets", () => {
  it("number tickets, record history and tell the people who handle tickets", async () => {
    const t = await newTicket(support);
    expect(t.ticket_number).toMatch(/^TKT-\d{6}$/);
    expect(t.status).toBe("open");
    const events = await q(`select event_type, to_value, actor_id from ticket_events where ticket_id = $1`, [t.id]);
    expect(events).toEqual([{ event_type: "created", to_value: "open", actor_id: support.id }]);
    const toOwner = await inbox(owner, "customer_complaint");
    expect(toOwner.some((n) => n.title.startsWith(t.ticket_number) && n.link === `/support/${t.id}` && n.body.includes("Amina Otieno"))).toBe(true);
    expect((await inbox(support2, "customer_complaint")).some((n) => n.title.startsWith(t.ticket_number))).toBe(true);
    // Not the person who raised it, and not finance (no tickets:edit).
    expect((await inbox(support, "customer_complaint")).some((n) => n.title.startsWith(t.ticket_number))).toBe(false);
    expect((await inbox(finance, "customer_complaint")).length).toBe(0);
  });

  it("assigning moves an open ticket to assigned, records it and notifies the assignee", async () => {
    const t = await newTicket(owner);
    await asUserCommit(owner, (c) => c.query(`update support_tickets set assigned_to = $2 where id = $1`, [t.id, support2.id]));
    const row = (await q(`select status from support_tickets where id = $1`, [t.id]))[0];
    expect(row.status).toBe("assigned");
    const ev = await q(`select event_type, from_value, to_value from ticket_events where ticket_id = $1 order by created_at`, [t.id]);
    expect(ev.map((e) => e.event_type)).toEqual(["created", "status", "assigned"]);
    expect((await inbox(support2, "customer_complaint")).some((n) => n.title === `Assigned to you: ${t.ticket_number}`)).toBe(true);
    // Unassigning puts it back to open.
    await asUserCommit(owner, (c) => c.query(`update support_tickets set assigned_to = null where id = $1`, [t.id]));
    expect((await q(`select status from support_tickets where id = $1`, [t.id]))[0].status).toBe("open");
  });

  it("only active staff of the ISP can be assigned", async () => {
    const t = await newTicket(owner);
    const r = await asUser(owner, (c) => tryQuery(c, `update support_tickets set assigned_to = $2 where id = $1`, [t.id, outsider.id]));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/active staff/);
  });

  it("resolving needs a resolution, sets the dates, and reopening clears them", async () => {
    const t = await newTicket(owner);
    const bad = await asUser(owner, (c) => tryQuery(c, `update support_tickets set status = 'resolved' where id = $1`, [t.id]));
    expect(!bad.ok && bad.error).toMatch(/how the issue was resolved/);
    await asUserCommit(owner, (c) =>
      c.query(`update support_tickets set status = 'resolved', resolution_notes = 'Reset the ONT; speeds back to 20 Mbps' where id = $1`, [t.id]),
    );
    let row = (await q(`select resolved_at, closed_at from support_tickets where id = $1`, [t.id]))[0];
    expect(row.resolved_at).not.toBeNull();
    expect(row.closed_at).toBeNull();
    await asUserCommit(owner, (c) => c.query(`update support_tickets set status = 'closed' where id = $1`, [t.id]));
    row = (await q(`select resolved_at, closed_at from support_tickets where id = $1`, [t.id]))[0];
    expect(row.closed_at).not.toBeNull();
    await asUserCommit(owner, (c) => c.query(`update support_tickets set status = 'open' where id = $1`, [t.id]));
    row = (await q(`select resolved_at, closed_at from support_tickets where id = $1`, [t.id]))[0];
    expect(row).toEqual({ resolved_at: null, closed_at: null });
    const status = await q(`select from_value, to_value, note from ticket_events where ticket_id = $1 and event_type = 'status' order by created_at`, [t.id]);
    expect(status.map((s) => s.to_value)).toEqual(["resolved", "closed", "open"]);
    expect(status[0].note).toMatch(/Reset the ONT/);
  });

  it("comments: ticket staff and the assignee can add them; finance and outsiders cannot; events cannot be written directly", async () => {
    const t = await newTicket(owner, { assigned_to: tech.id });
    await asUserCommit(support, (c) => c.query(`select add_ticket_comment($1, 'Called the customer; router lights all green')`, [t.id]));
    await asUserCommit(tech, (c) => c.query(`select add_ticket_comment($1, 'Will visit at 2 pm')`, [t.id]));
    const f = await asUser(finance, (c) => tryQuery(c, `select add_ticket_comment($1, 'x')`, [t.id]));
    expect(f.ok).toBe(false);
    const o = await asUser(outsider, (c) => tryQuery(c, `select add_ticket_comment($1, 'x')`, [t.id]));
    expect(o.ok).toBe(false);
    const empty = await asUser(support, (c) => tryQuery(c, `select add_ticket_comment($1, '   ')`, [t.id]));
    expect(empty.ok).toBe(false);
    const direct = await asUser(support, (c) =>
      tryQuery(c, `insert into ticket_events (tenant_id, ticket_id, event_type, note) values ($1, $2, 'comment', 'forged')`, [tenant, t.id]),
    );
    expect(direct.ok).toBe(false);
    const notes = await asUser(tech, (c) => c.query(`select note from ticket_events where ticket_id = $1 and event_type = 'comment' order by created_at`, [t.id]).then((r) => r.rows));
    expect(notes.map((n) => n.note)).toEqual(["Called the customer; router lights all green", "Will visit at 2 pm"]);
  });
});

describe("field jobs", () => {
  it("assigning a job notifies the technician and links to the ticket's history", async () => {
    const t = await newTicket(support);
    const job = await asUserCommit(support, (c) =>
      c
        .query(
          `insert into installation_jobs (tenant_id, customer_id, ticket_id, technician_id, job_type, scheduled_for, created_by)
           values ($1, $2, $3, $4, 'fault_investigation', now() + interval '1 day', $5) returning id, job_number`,
          [tenant, customer, t.id, techId, support.id],
        )
        .then((r) => r.rows[0]),
    );
    expect(job.job_number).toMatch(/^JOB-\d{6}$/);
    const toTech = await inbox(tech, "customer_complaint");
    expect(toTech.some((n) => n.title.startsWith(`New job: ${job.job_number}`) && n.link === `/field-operations/${job.id}`)).toBe(true);
    const tev = await q(`select event_type, to_value from ticket_events where ticket_id = $1 and event_type = 'job'`, [t.id]);
    expect(tev).toEqual([{ event_type: "job", to_value: job.job_number }]);
  });

  it("technician progresses their job: start time, notes, completion needs notes, then it is closed to them", async () => {
    const [{ id: job }] = await q<{ id: string }>(
      `insert into installation_jobs (tenant_id, customer_id, technician_id, job_type, created_by) values ($1, $2, $3, 'installation', $4) returning id`,
      [tenant, customer, techId, owner.id],
    );
    await asUserCommit(tech, (c) => c.query(`update installation_jobs set status = 'in_progress' where id = $1`, [job]));
    expect((await q(`select started_at from installation_jobs where id = $1`, [job]))[0].started_at).not.toBeNull();
    await asUserCommit(tech, (c) => c.query(`select add_job_note($1, 'Fibre drop run from the pole, 40 m')`, [job]));
    const other = await asUser(tech2, (c) => tryQuery(c, `select add_job_note($1, 'not mine')`, [job]));
    expect(other.ok).toBe(false);
    const noNotes = await asUser(tech, (c) => tryQuery(c, `update installation_jobs set status = 'completed' where id = $1`, [job]));
    expect(!noNotes.ok && noNotes.error).toMatch(/Record what was done/);
    await asUserCommit(tech, (c) =>
      c.query(`update installation_jobs set status = 'completed', completion_notes = 'ONT installed, 20 Mbps tested' where id = $1`, [job]),
    );
    expect((await q(`select completed_at from installation_jobs where id = $1`, [job]))[0].completed_at).not.toBeNull();
    const reopen = await asUser(tech, (c) => tryQuery(c, `update installation_jobs set status = 'in_progress' where id = $1`, [job]));
    expect(reopen.ok).toBe(false);
    // A supervisor can reopen.
    const sup = await asUser(support, (c) => tryQuery(c, `update installation_jobs set status = 'in_progress' where id = $1`, [job]));
    expect(sup.ok).toBe(true);
    const events = await q(`select event_type, to_value from job_events where job_id = $1 order by created_at`, [job]);
    expect(events.map((e) => `${e.event_type}:${e.to_value ?? ""}`)).toEqual([
      "created:scheduled",
      `assigned:${techId}`,
      "status:in_progress",
      "note:",
      "status:completed",
    ]);
    // Completion tells the people who plan jobs.
    expect((await inbox(owner, "installation_completion")).some((n) => n.title.startsWith("Installation completed") && n.body.includes("ONT installed"))).toBe(true);
    expect((await inbox(tech, "installation_completion")).length).toBe(0);
  });

  it("another technician cannot see or update someone else's job", async () => {
    const [{ id: job }] = await q<{ id: string }>(
      `insert into installation_jobs (tenant_id, customer_id, technician_id, job_type, created_by) values ($1, $2, $3, 'maintenance', $4) returning id`,
      [tenant, customer, techId, owner.id],
    );
    await asUser(tech2, async (c) => {
      expect(await count(c, `select count(*) from installation_jobs where id = $1`, [job])).toBe(0);
      expect(await count(c, `select count(*) from job_events where job_id = $1`, [job])).toBe(0);
      const r = await tryQuery(c, `update installation_jobs set status = 'in_progress' where id = $1`, [job]);
      expect(r.ok && r.rowCount).toBe(0);
    });
    expect(tech2Id).toBeTruthy();
  });
});

describe("notification preferences", () => {
  it("a person can mute a type for themselves; the ISP owner can mute it for everyone", async () => {
    await asUserCommit(support2, (c) =>
      c.query(`insert into notification_preferences (tenant_id, profile_id, type, in_app) values ($1, $2, 'customer_complaint', false)`, [tenant, support2.id]),
    );
    const before = (await inbox(support2, "customer_complaint")).length;
    const ownerBefore = (await inbox(owner, "customer_complaint")).length;
    await newTicket(support);
    expect((await inbox(support2, "customer_complaint")).length).toBe(before);
    expect((await inbox(owner, "customer_complaint")).length).toBe(ownerBefore + 1);

    // Support cannot set the ISP-wide preference; the owner can.
    const denied = await asUser(support, (c) =>
      tryQuery(c, `insert into notification_preferences (tenant_id, profile_id, type, in_app) values ($1, null, 'customer_complaint', false)`, [tenant]),
    );
    expect(denied.ok).toBe(false);
    await asUserCommit(owner, (c) =>
      c.query(`insert into notification_preferences (tenant_id, profile_id, type, in_app) values ($1, null, 'customer_complaint', false)`, [tenant]),
    );
    await newTicket(support);
    expect((await inbox(owner, "customer_complaint")).length).toBe(ownerBefore + 1);
    await q(`delete from notification_preferences where tenant_id = $1 and profile_id is null`, [tenant]);
  });

  it("nobody can set preferences for someone else", async () => {
    const r = await asUser(support, (c) =>
      tryQuery(c, `insert into notification_preferences (tenant_id, profile_id, type) values ($1, $2, 'payment_failure')`, [tenant, owner.id]),
    );
    expect(r.ok).toBe(false);
  });

  it("email and SMS choices queue copies in the outbox for a delivery worker", async () => {
    await asUserCommit(owner, (c) =>
      c.query(`insert into notification_preferences (tenant_id, profile_id, type, email, sms) values ($1, $2, 'installation_completion', true, true)`, [tenant, owner.id]),
    );
    const [{ id: job }] = await q<{ id: string }>(
      `insert into installation_jobs (tenant_id, customer_id, technician_id, job_type, created_by) values ($1, $2, $3, 'equipment_replacement', $4) returning id`,
      [tenant, customer, techId, owner.id],
    );
    await asUserCommit(tech, (c) => c.query(`update installation_jobs set status = 'completed', completion_notes = 'Swapped the ONT' where id = $1`, [job]));
    const rows = await asUser(owner, (c) =>
      c
        .query(
          `select o.channel, o.status from notification_outbox o join notifications n on n.id = o.notification_id
           where n.link = $1 order by o.channel`,
          [`/field-operations/${job}`],
        )
        .then((r) => r.rows),
    );
    expect(rows).toEqual([
      { channel: "email", status: "pending" },
      { channel: "sms", status: "pending" },
    ]);
    // Other people cannot read someone's outbox.
    expect(await asUser(support, (c) => count(c, `select count(*) from notification_outbox where recipient_id = $1`, [owner.id]))).toBe(0);
  });
});

describe("payment, expiry and outage notifications", () => {
  it("verified and rejected payments notify finance and the owner; simulated ones never do", async () => {
    const [{ id: good }] = await q<{ id: string }>(
      `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at, status, data_source)
       values ($1, $2, 'mpesa', $3, 2000, now(), 'successful', 'manual') returning id`,
      [tenant, customer, `OPS${runId}A`.toUpperCase()],
    );
    await q(`update payments set verification_status = 'verified', verified_at = now() where id = $1`, [good]);
    expect((await inbox(finance, "payment_confirmation")).some((n) => n.body.includes("Ksh 2,000.00") && n.body.includes("Amina Otieno"))).toBe(true);
    expect((await inbox(support, "payment_confirmation")).length).toBe(0);

    const [{ id: bad }] = await q<{ id: string }>(
      `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at, status, data_source)
       values ($1, $2, 'mpesa', $3, 1500, now(), 'successful', 'manual') returning id`,
      [tenant, customer, `OPS${runId}B`.toUpperCase()],
    );
    await q(`update payments set verification_status = 'rejected' where id = $1`, [bad]);
    expect((await inbox(owner, "payment_failure")).some((n) => n.title === "Payment rejected" && n.link === `/payments/${bad}`)).toBe(true);

    const before = (await inbox(owner)).length;
    const [{ id: sim }] = await q<{ id: string }>(
      `insert into payments (tenant_id, customer_id, method, provider_reference, amount, transaction_at, status, data_source)
       values ($1, $2, 'mpesa', $3, 999, now(), 'successful', 'simulated') returning id`,
      [tenant, customer, `OPS${runId}C`.toUpperCase()],
    );
    await q(`update payments set verification_status = 'rejected' where id = $1`, [sim]);
    expect((await inbox(owner)).length).toBe(before);
  });

  it("warns about packages ending within 3 days, once per period", async () => {
    const [{ id: pkg }] = await q<{ id: string }>(
      `insert into service_packages (tenant_id, name, download_mbps, upload_mbps, price, billing_period) values ($1, 'Lite', 10, 10, 1500, 'monthly') returning id`,
      [tenant],
    );
    await q(
      `insert into subscriptions (tenant_id, customer_id, package_id, status, starts_at, expires_at, price, billing_period)
       values ($1, $2, $3, 'active', now() - interval '29 days', now() + interval '1 day', 1500, 'monthly')`,
      [tenant, customer, pkg],
    );
    const n1 = await asUserCommit(support, (c) => c.query(`select notify_expiring_subscriptions($1) as n`, [tenant]).then((r) => r.rows[0].n));
    expect(n1).toBe(1);
    await asUserCommit(support, (c) => c.query(`select notify_expiring_subscriptions($1)`, [tenant]));
    const expiry = await inbox(owner, "subscription_expiry");
    expect(expiry).toHaveLength(1);
    expect(expiry[0]).toMatchObject({ title: "Amina Otieno's package ends soon", link: `/customers/${customer}` });
    const r = await asUser(outsider, (c) => tryQuery(c, `select notify_expiring_subscriptions($1)`, [tenant]));
    expect(r.ok).toBe(false);
  });

  it("two real routers offline at once raise a network outage", async () => {
    const routers = await q<{ id: string }>(
      `insert into routers (tenant_id, name, status, data_source) values ($1, 'Ops A', 'offline', 'manual'), ($1, 'Ops B', 'offline', 'manual') returning id`,
      [tenant],
    );
    await q(
      `insert into network_alerts (tenant_id, router_id, severity, alert_type, title, data_source) values ($1, $2, 'critical', 'router_offline', 'Ops B offline', 'connector')`,
      [tenant, routers[1].id],
    );
    const outage = await inbox(support, "network_outage");
    expect(outage).toHaveLength(1);
    expect(outage[0].title).toBe("Network outage: 2 routers offline");
  });
});

describe("business intelligence reports", () => {
  const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const call = (user: TestUser, fn: string, extra = "") =>
    asUser(user, (c) => tryQuery(c, `select * from public.${fn}($1, $2::date, $3::date${extra})`, [tenant, today(), today()]));

  it("each report needs its permission", async () => {
    for (const fn of ["bi_payment_report", "bi_area_report", "bi_subscription_report"]) {
      expect((await call(finance, fn)).ok).toBe(true);
      const denied = await call(support, fn);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("42501");
    }
    expect((await call(support, "bi_support_report")).ok).toBe(true);
    expect((await call(finance, "bi_support_report")).ok).toBe(false);
    expect((await call(tech, "bi_support_report")).ok).toBe(false);
    expect((await call(outsider, "bi_payment_report")).ok).toBe(false);
    // Customer churn also needs customers:view, which finance does not have.
    expect((await call(owner, "bi_customer_report")).ok).toBe(true);
    // Router report: rows only for reports:network holders.
    const routerRows = (u: TestUser) =>
      asUser(u, (c) => c.query(`select name from public.router_report($1, now() - interval '1 day', now())`, [tenant]).then((r) => r.rows.map((x) => x.name)));
    await q(`insert into routers (tenant_id, name, status, data_source) values ($1, 'BI test router', 'online', 'manual')`, [tenant]);
    expect(await routerRows(owner)).toContain("BI test router");
    expect(await routerRows(support)).toEqual([]);
  });

  it("payment reconciliation counts real payments by status and leaves simulated ones out", async () => {
    const r = await call(finance, "bi_payment_report");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = Object.fromEntries(r.rows.map((x) => [String(x.state), Number(x.amount)]));
    expect(by["Verified, not yet on a statement"]).toBe(2000);
    expect(by["Rejected at verification"]).toBe(1500);
    expect(r.rows.some((x) => Number(x.amount) === 999)).toBe(false);
  });

  it("support report counts tickets and jobs opened today, with resolution times", async () => {
    const t = await newTicket(support, { category: "equipment_fault" });
    await q(`update support_tickets set status = 'resolved', resolution_notes = 'Swapped the ONT' where id = $1`, [t.id]);
    const r = await call(support, "bi_support_report");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tickets = r.rows.filter((x) => x.kind === "ticket");
    expect(tickets.reduce((s, x) => s + Number(x.opened), 0)).toBeGreaterThan(0);
    const fault = tickets.find((x) => x.label === "equipment_fault");
    expect(Number(fault?.resolved)).toBe(1);
    expect(fault?.avg_hours).not.toBeNull();
    expect(Number(fault?.within_24h_pct)).toBe(100);
    expect(r.rows.some((x) => x.kind === "technician")).toBe(true);
  });

  it("area report groups customers by area and rejects silly ranges", async () => {
    await q(`update customers set estate = 'Roysambu' where id = $1`, [customer]);
    const r = await call(owner, "bi_area_report");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows.find((x) => x.area === "Roysambu")?.collected).toBe("2000.00");
    const bad = await asUser(owner, (c) => tryQuery(c, `select * from public.bi_area_report($1, '2026-05-02', '2026-05-01')`, [tenant]));
    expect(bad.ok).toBe(false);
  });
});
