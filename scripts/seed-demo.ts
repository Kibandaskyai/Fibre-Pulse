/**
 * Seeds a LOCAL Supabase with fictional demo data for Phase 1.
 *
 *   npm run db:seed
 *
 * Creates:
 *   - a FibrePulse super admin and a support admin
 *   - (Phase 2) subscriptions and their invoices for active demo customers,
 *     bought through the real purchase_subscription function as the owner,
 *     and two SIMULATED M-Pesa payments that can never be verified
 *   - "Mwangaza Fibre Networks" (active) with one user per ISP role
 *   - "Pwani Connect" (pending) to demonstrate tenant isolation
 *   - fictional customers (no monthly packages until the client gives prices), and SIMULATED routers
 *   - (Phase 6) Mwangaza's signed 2.75% agreement from October 2026
 *   - (Phase 8) the pilot's 9 hotspot plans, M-Pesa-only settings and a few
 *     SIMULATED hotspot codes (DEMO00…DEMO11). The demo WiFi page is
 *     /wifi/mwangaza
 *   - (Phase 4) a demo connector for the simulated routers. Its token is
 *     written to connector/mikrotik-agent/.env (git-ignored) so
 *     `npm run connector:demo` reports SIMULATED readings to the local app.
 *
 * All people, phone numbers and places are fictional. Router rows are marked
 * data_source = 'simulated'. No verified payments are created: demo payments
 * are simulated, so they never count as revenue or pay an invoice.
 *
 * Refuses to run against anything but a local Supabase.
 */
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DEMO_PASSWORD = "FibrePulse-Demo-2026";

function localConfig() {
  const status = JSON.parse(execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString());
  const url: string = status.API_URL;
  const key: string = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error(`Refusing to seed a non-local Supabase: ${url}`);
  return { url, key };
}

const { url, key } = localConfig();
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function user(email: string, fullName: string) {
  const { data: found } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
  if (found) return found.id as string;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) throw error;
  return data.user.id;
}

async function must<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data;
}

async function tenant(name: string, slug: string, county: string, town: string, status: "active" | "pending", ownerId: string) {
  const existing = await must(db.from("tenants").select("id").eq("slug", slug).maybeSingle());
  if (existing) return (existing as { id: string }).id;
  const t = await must(
    db.from("tenants").insert({ name, slug, county, town, status, created_by: ownerId, customer_number_prefix: slug === "mwangaza" ? "MFN" : "PWC" }).select("id").single(),
  );
  const id = (t as { id: string }).id;
  await must(db.from("tenant_members").insert({ tenant_id: id, profile_id: ownerId, role: "owner" }));
  await must(
    db.from("commercial_agreements").insert({
      tenant_id: id, version: 1, status: "draft", fee_rate: 0.0275, fee_basis: "gross",
      effective_from: "2026-12-01", notes: "Pilot terms: 2.75% of gross verified subscription collections. Draft until signed.",
    }),
  );
  return id;
}

async function main() {
  console.log("Seeding local FibrePulse demo data…");

  const superAdmin = await user("admin@fibrepulse.test", "Amani Platform Admin");
  const supportAdmin = await user("support@fibrepulse.test", "Baraka Support Admin");
  await must(db.from("profiles").update({ platform_role: "super_admin" }).eq("id", superAdmin));
  await must(db.from("profiles").update({ platform_role: "support_admin" }).eq("id", supportAdmin));

  const owner = await user("owner@mwangaza.test", "Wanjiku Kamau");
  const finance = await user("finance@mwangaza.test", "Otieno Ochieng");
  const network = await user("network@mwangaza.test", "Kiprono Langat");
  const support = await user("support@mwangaza.test", "Achieng Atieno");
  const tech = await user("tech@mwangaza.test", "Mutua Musyoka");
  const pwaniOwner = await user("owner@pwani.test", "Hassan Mohamed");

  const mwangaza = await tenant("Mwangaza Fibre Networks", "mwangaza", "Nairobi", "Kasarani", "active", owner);
  await tenant("Pwani Connect", "pwani", "Mombasa", "Nyali", "pending", pwaniOwner);

  for (const [profile, role] of [[finance, "finance"], [network, "network_admin"], [support, "support_agent"], [tech, "technician"]] as const) {
    await db.from("tenant_members").upsert({ tenant_id: mwangaza, profile_id: profile, role }, { onConflict: "tenant_id,profile_id" });
  }
  await db.from("technicians").upsert({ tenant_id: mwangaza, profile_id: tech, zone: "Kasarani / Roysambu", phone: "+254700100005" }, { onConflict: "tenant_id,profile_id" });

  // No monthly packages are seeded: the first list (23 Nov 2026) was
  // tentative and the client has not given monthly prices yet. The owner
  // adds them under Packages. Demo monthly customers start with no package.

  // Phase 8 (client update 24 Nov 2026): the pilot ISP mostly sells hotspot
  // time per device, all 10 Mbps, paid by M-Pesa paybill only. Prices are the
  // client's current plans. Limited/Unlimited labels are copied as shown and
  // carry no data cap until the client explains them.
  const t = (await must(db.from("tenants").select("settings").eq("id", mwangaza).single())) as { settings: Record<string, unknown> | null };
  await must(
    db.from("tenants").update({
      settings: {
        ...(t.settings ?? {}),
        payment_methods: ["mpesa"],
        mpesa_paybill: "000000", // fictional placeholder until the client gives theirs
        upstream_provider: "Safaricom",
        upstream_support_phone: "0722 000 000", // fictional placeholder
        portal_demo: true, // lets the demo WiFi page simulate an M-Pesa payment
      },
    }).eq("id", mwangaza),
  );
  const hotspotPlans = [
    { name: "1 Hour", duration_minutes: 60, price: 10, usage_type: "limited" },
    { name: "3 Hours", duration_minutes: 180, price: 15, usage_type: "limited" },
    { name: "8 Hours", duration_minutes: 480, price: 30, usage_type: "limited" },
    { name: "12 Hours", duration_minutes: 720, price: 40, usage_type: "limited" },
    { name: "24 Hours", duration_minutes: 1440, price: 50, usage_type: "limited" },
    { name: "2 Days", duration_minutes: 2880, price: 70, usage_type: "unlimited" },
    { name: "3 Days", duration_minutes: 4320, price: 100, usage_type: "unlimited" },
    { name: "7 Days", duration_minutes: 10080, price: 250, usage_type: "unlimited" },
    { name: "Monthly", duration_minutes: 43200, price: 700, usage_type: "unlimited" },
  ];
  for (const [i, hp] of hotspotPlans.entries()) {
    await db.from("hotspot_plans").upsert({ tenant_id: mwangaza, download_mbps: 10, upload_mbps: 10, sort_order: i, ...hp }, { onConflict: "tenant_id,name" });
  }
  const { count: codeCount } = await db.from("hotspot_vouchers").select("id", { count: "exact", head: true }).eq("tenant_id", mwangaza);
  if (!codeCount) {
    // SIMULATED codes and devices so the hotspot screens have something to
    // show. Their payments are simulated and never count as revenue.
    const { data: plans } = await db.from("hotspot_plans").select("id, name, price, duration_minutes").eq("tenant_id", mwangaza);
    const byPlan = new Map((plans ?? []).map((p) => [p.name as string, p]));
    const now = Date.now();
    const demo: { plan: string; state: "unused" | "active" | "expired"; minutesAgo: number }[] = [
      { plan: "24 Hours", state: "active", minutesAgo: 90 }, { plan: "24 Hours", state: "active", minutesAgo: 600 },
      { plan: "1 Hour", state: "active", minutesAgo: 20 }, { plan: "3 Hours", state: "active", minutesAgo: 45 },
      { plan: "2 Days", state: "active", minutesAgo: 1500 }, { plan: "7 Days", state: "active", minutesAgo: 4000 },
      { plan: "Monthly", state: "active", minutesAgo: 20000 }, { plan: "8 Hours", state: "active", minutesAgo: 400 },
      { plan: "24 Hours", state: "unused", minutesAgo: 5 }, { plan: "12 Hours", state: "unused", minutesAgo: 30 },
      { plan: "1 Hour", state: "expired", minutesAgo: 180 }, { plan: "3 Hours", state: "expired", minutesAgo: 300 },
    ];
    for (const [i, d] of demo.entries()) {
      const plan = byPlan.get(d.plan)!;
      const phone = `+25470010${String(10000 + i).slice(1)}`;
      const boughtAt = new Date(now - d.minutesAgo * 60_000 - 60_000).toISOString();
      const mac = `02:5d:00:00:00:${(16 + i).toString(16)}`;
      const pay = (await must(
        db.from("payments").insert({
          tenant_id: mwangaza, customer_id: null, method: "mpesa", provider_reference: `SIMHS${String(i).padStart(5, "0")}`, amount: plan.price,
          payer_phone: phone, transaction_at: boughtAt, status: "successful", verification_status: "unverified", data_source: "simulated",
          description: "Simulated hotspot M-Pesa payment for the demo. Never counts as revenue.",
        }).select("id").single(),
      )) as { id: string };
      let deviceId: string | null = null;
      if (d.state !== "unused") {
        const dev = (await must(
          db.from("hotspot_devices").upsert({ tenant_id: mwangaza, mac_address: mac, last_phone: phone, purchases: 1, total_spent: plan.price, data_source: "simulated" }, { onConflict: "tenant_id,mac_address" }).select("id").single(),
        )) as { id: string };
        deviceId = dev.id;
      }
      const activatedAt = d.state === "unused" ? null : new Date(now - d.minutesAgo * 60_000);
      const expiresAt = activatedAt ? new Date(activatedAt.getTime() + Number(plan.duration_minutes) * 60_000) : null;
      await must(
        db.from("hotspot_vouchers").insert({
          tenant_id: mwangaza, code: `DEMO${String(i).padStart(2, "0")}`, plan_id: plan.id, plan_name: plan.name, price: plan.price,
          duration_minutes: plan.duration_minutes, download_mbps: 10, upload_mbps: 10, source: "portal", status: d.state, phone,
          device_id: deviceId, mac_address: deviceId ? mac : null, payment_id: pay.id, data_source: "simulated",
          activated_at: activatedAt?.toISOString() ?? null, expires_at: expiresAt?.toISOString() ?? null,
          ended_at: d.state === "expired" ? expiresAt?.toISOString() : null, end_reason: d.state === "expired" ? "Time used up" : null,
          created_at: boughtAt,
        }),
      );
    }
  }

  const { count } = await db.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", mwangaza);
  if (!count) {
    const people = [
      ["Grace Wambui", "Kasarani", "Nairobi"], ["Peter Njoroge", "Roysambu", "Nairobi"], ["Mercy Chebet", "Zimmerman", "Nairobi"],
      ["Daniel Odhiambo", "Mwiki", "Nairobi"], ["Faith Nyambura", "Clay City", "Nairobi"], ["Kevin Mutiso", "Garden Estate", "Nairobi"],
      ["Esther Akinyi", "Kahawa West", "Nairobi"], ["Brian Kiplagat", "Githurai 45", "Kiambu"], ["Lucy Wanjiru", "Ruiru", "Kiambu"],
      ["Samuel Mwenda", "Thome", "Nairobi"], ["Joyce Moraa", "Lucky Summer", "Nairobi"], ["Collins Wekesa", "Seasons", "Nairobi"],
    ];
    const statuses = ["active", "active", "active", "active", "active", "active", "active", "suspended", "pending_installation", "active", "disconnected", "active"];
    await must(
      db.from("customers").insert(
        people.map(([name, estate, county], i) => ({
          tenant_id: mwangaza,
          full_name: name,
          phone: `+25470011${String(1000 + i)}`,
          estate,
          town: county === "Kiambu" ? estate : "Nairobi",
          county,
          status: statuses[i],
          notes: "Fictional demo customer",
          created_by: owner,
        })),
      ),
    );
  }

  for (const r of [
    { name: "Kasarani Core (simulated)", model: "CCR2004-1G-12S+2XS", location_name: "Kasarani POP", latitude: -1.2219, longitude: 36.8981 },
    { name: "Roysambu Distribution (simulated)", model: "RB5009UG+S+IN", location_name: "Roysambu cabinet", latitude: -1.2185, longitude: 36.8857 },
  ]) {
    await db.from("routers").upsert({ tenant_id: mwangaza, data_source: "simulated", status: "unknown", ...r }, { onConflict: "tenant_id,name" });
  }

  // Phase 4: a demo connector for the simulated routers. The token is rotated
  // on every seed and written only to the git-ignored local agent .env file.
  const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const token = "fpc_" + Array.from(randomBytes(40), (b) => BASE62[b % 62]).join("");
  const tokenFields = { token_hash: createHash("sha256").update(token).digest("hex"), token_prefix: token.slice(0, 12), status: "pending" };
  const existingAgent = await must(db.from("connector_agents").select("id").eq("tenant_id", mwangaza).eq("name", "Demo simulator").maybeSingle());
  const agentRow = (existingAgent
    ? await must(db.from("connector_agents").update(tokenFields).eq("id", (existingAgent as { id: string }).id).select("id").single())
    : await must(db.from("connector_agents").insert({ tenant_id: mwangaza, name: "Demo simulator", created_by: owner, ...tokenFields }).select("id").single())) as { id: string };
  const agentId = agentRow.id;
  await db.from("routers").update({ connector_agent_id: agentId, monitoring_enabled: true }).eq("tenant_id", mwangaza).eq("data_source", "simulated");
  writeFileSync(
    join(process.cwd(), "connector/mikrotik-agent/.env"),
    `# Written by npm run db:seed for the LOCAL demo only. Simulated routers, no real devices.\nFIBREPULSE_URL=http://localhost:3000\nFIBREPULSE_TOKEN=${token}\nSIMULATE=true\nALLOW_ROUTER_WRITES=false\nPOLL_INTERVAL_SECONDS=60\nSYNC_INTERVAL_SECONDS=15\n`,
    { mode: 0o600 },
  );

  // Link demo customers to the PPPoE usernames the simulator reports, so the
  // NOC and customer profiles show who is online (all SIMULATED sessions).
  const simUser = (router: string, i: number) => `sim-${router.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 12)}-${String(i).padStart(2, "0")}`;
  const { data: linkable } = await db.from("customers").select("id").eq("tenant_id", mwangaza).in("status", ["active", "suspended"]).is("pppoe_username", null).order("customer_number");
  const slots = [...[1, 2, 3, 4, 5].map((i) => simUser("Kasarani Core (simulated)", i)), ...[1, 2, 3, 4].map((i) => simUser("Roysambu Distribution (simulated)", i))];
  for (const [i, c] of (linkable ?? []).slice(0, slots.length).entries()) {
    await db.from("customers").update({ pppoe_username: slots[i] }).eq("id", c.id);
  }

  // Phase 2: sell packages through the real database function, signed in as
  // the owner, so invoices and audit rows are exactly what the app creates.
  const { count: subCount } = await db.from("subscriptions").select("id", { count: "exact", head: true }).eq("tenant_id", mwangaza);
  const { data: monthlyPkgs } = await db.from("service_packages").select("id, name").eq("tenant_id", mwangaza).eq("status", "active");
  if (!subCount && monthlyPkgs?.length) {
    const asOwner = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await asOwner.auth.signInWithPassword({ email: "owner@mwangaza.test", password: DEMO_PASSWORD });
    if (signInError) throw signInError;
    const { data: custs } = await db.from("customers").select("id, full_name, status").eq("tenant_id", mwangaza).order("customer_number");
    let i = 0;
    for (const c of custs ?? []) {
      if (c.status !== "active" && c.status !== "suspended") continue;
      const pkg = monthlyPkgs[i++ % monthlyPkgs.length].id;
      const { data: subId, error } = await asOwner.rpc("purchase_subscription", { p_customer: c.id, p_package: pkg });
      if (error) throw error;
      if (c.status === "suspended") {
        await asOwner.rpc("suspend_subscription", { p_subscription: subId, p_reason: "Demo: account suspended for non-payment" });
      }
    }
    const simulatedPayer = (custs ?? [])[0];
    for (const [ref, amount] of [["SIMDEMO001", 2000], ["SIMDEMO002", 450]] as const) {
      await db.from("payments").insert({
        tenant_id: mwangaza, customer_id: simulatedPayer?.id ?? null, method: "mpesa", provider_reference: ref, amount,
        transaction_at: new Date().toISOString(), status: "successful", verification_status: "unverified", data_source: "simulated",
        description: "Simulated M-Pesa payment for the demo. Never counts as revenue.",
      });
    }
    await asOwner.auth.signOut();
  }

  // Phase 5: coverage circles for the simulated routers, approximate demo
  // map points for customers (estate centre plus a small offset, never a real
  // address), and a few tickets and a job created as real staff so triggers
  // write the same history and notifications the app does.
  await db.from("routers").update({ coverage_radius_m: 1500 }).eq("tenant_id", mwangaza).eq("name", "Kasarani Core (simulated)");
  await db.from("routers").update({ coverage_radius_m: 900 }).eq("tenant_id", mwangaza).eq("name", "Roysambu Distribution (simulated)");
  const ESTATES: Record<string, [number, number]> = {
    Kasarani: [-1.2219, 36.8981], Roysambu: [-1.2185, 36.8857], Zimmerman: [-1.2133, 36.8946], Mwiki: [-1.221, 36.933],
    "Clay City": [-1.23, 36.905], "Garden Estate": [-1.229, 36.865], "Kahawa West": [-1.185, 36.889], "Githurai 45": [-1.2, 36.915],
    Ruiru: [-1.146, 36.96], Thome: [-1.214, 36.874], "Lucky Summer": [-1.236, 36.893], Seasons: [-1.23, 36.887],
  };
  const { data: located } = await db.from("customers").select("id, estate, customer_number").eq("tenant_id", mwangaza).order("customer_number");
  for (const [i, c] of (located ?? []).entries()) {
    const centre = ESTATES[c.estate as string];
    if (!centre) continue;
    const off = ((i % 5) - 2) * 0.0012;
    await db.from("customer_locations").upsert(
      { customer_id: c.id, tenant_id: mwangaza, latitude: centre[0] + off, longitude: centre[1] - off, accuracy_m: 50 },
      { onConflict: "customer_id" },
    );
  }

  const { count: ticketCount } = await db.from("support_tickets").select("id", { count: "exact", head: true }).eq("tenant_id", mwangaza);
  if (!ticketCount) {
    const as = async (email: string) => {
      const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await c.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
      if (error) throw error;
      return c;
    };
    const agent = await as("support@mwangaza.test");
    const byEstate = new Map((located ?? []).map((c) => [c.estate as string, c.id as string]));
    const ticket = async (estate: string, category: string, priority: string, subject: string, description: string, assignedTo: string | null) =>
      (await must(
        agent.from("support_tickets").insert({
          tenant_id: mwangaza, customer_id: byEstate.get(estate) ?? null, category, priority, subject, description, assigned_to: assignedTo, created_by: support,
        }).select("id").single(),
      )) as { id: string };
    const t1 = await ticket("Zimmerman", "no_internet", "high", "No internet since last night", "Customer says the router lights are on but nothing loads. Fictional demo ticket.", support);
    const t2 = await ticket("Mwiki", "slow_internet", "medium", "Slow speeds in the evening", "Speeds drop below 5 Mbps after 8 PM. Fictional demo ticket.", null);
    const t3 = await ticket("Kasarani", "payment_issue", "low", "Paid but still shows a balance", "Customer sent an M-Pesa message. Fictional demo ticket.", support);
    await must(agent.rpc("add_ticket_comment", { p_ticket: t1.id, p_note: "Called the customer. Fibre may be cut near the gate; sending a technician." }));
    await must(agent.from("support_tickets").update({ status: "resolved", resolution_notes: "Payment found and allocated; balance cleared." }).eq("id", t3.id));
    void t2;
    const { data: techRow } = await db.from("technicians").select("id").eq("tenant_id", mwangaza).eq("profile_id", tech).single();
    await must(
      agent.from("installation_jobs").insert({
        tenant_id: mwangaza, customer_id: byEstate.get("Zimmerman") ?? null, ticket_id: t1.id, technician_id: techRow?.id ?? null,
        job_type: "fault_investigation", scheduled_for: new Date(Date.now() + 3 * 3_600_000).toISOString(),
        address: "Zimmerman, near the main gate (fictional)", notes: "Check the drop cable and the ONT.", created_by: support,
      }),
    );
    await agent.auth.signOut();
  }

  // Phase 6: Mwangaza's commercial agreement, signed through the same admin
  // functions the platform pages use: 2.75% of gross subscription
  // collections from 1 October 2026. No fees or invoices are seeded, because
  // the demo has no verified payments; record and verify a real manual
  // payment, then calculate fees from /admin/tenants to see an invoice.
  const { count: signedCount } = await db.from("commercial_agreements").select("id", { count: "exact", head: true }).eq("tenant_id", mwangaza).neq("status", "draft");
  if (!signedCount) {
    const asAdmin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: adminSignIn } = await asAdmin.auth.signInWithPassword({ email: "admin@fibrepulse.test", password: DEMO_PASSWORD });
    if (adminSignIn) throw adminSignIn;
    const draft = (await must(db.from("commercial_agreements").select("id").eq("tenant_id", mwangaza).eq("status", "draft").maybeSingle())) as { id: string } | null;
    const { data: agreementId, error: saveError } = await asAdmin.rpc("admin_save_agreement", {
      p_tenant: mwangaza, p_agreement: draft?.id ?? null, p_fee_rate: 0.0275, p_fee_basis: "gross",
      p_excluded: ["installation", "equipment", "other"], p_effective_from: "2026-10-01",
      p_notes: "Pilot terms (fictional demo): 2.75% of gross internet subscription collections.",
    });
    if (saveError) throw saveError;
    const { error: signError } = await asAdmin.rpc("admin_sign_agreement", { p_agreement: agreementId, p_signed_by: "Wanjiku Kamau, Owner" });
    if (signError) throw signError;
    await asAdmin.auth.signOut();
  }

  await db.from("notifications").insert({
    tenant_id: mwangaza, recipient_id: owner, type: "system", title: "Welcome to FibrePulse",
    body: "This is a local demo workspace with fictional data. Routers are simulated.",
  });

  console.log(`
Done. Sign in at http://localhost:3000 with password ${DEMO_PASSWORD}:
  owner@mwangaza.test     ISP Owner (Mwangaza Fibre Networks, active)
  finance@mwangaza.test   Finance Manager
  network@mwangaza.test   Network Administrator
  support@mwangaza.test   Customer Support Agent
  tech@mwangaza.test      Field Technician
  owner@pwani.test        ISP Owner (Pwani Connect, pending activation)
  admin@fibrepulse.test   FibrePulse Super Administrator
  support@fibrepulse.test FibrePulse Support Administrator

Simulated network data: with the app running, start the demo connector with
  npm run connector:demo
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
