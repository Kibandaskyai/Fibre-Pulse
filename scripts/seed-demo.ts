/**
 * Seeds a LOCAL Supabase with fictional demo data for Phase 1.
 *
 *   npm run db:seed
 *
 * Creates:
 *   - a FibrePulse super admin and a support admin
 *   - "Mwangaza Fibre Networks" (active) with one user per ISP role
 *   - "Pwani Connect" (pending) to demonstrate tenant isolation
 *   - fictional packages and customers, and SIMULATED routers
 *
 * All people, phone numbers and places are fictional. Router rows are marked
 * data_source = 'simulated'. No payments are created: Phase 2 builds the
 * payment flows, and simulated payments are never counted as revenue.
 *
 * Refuses to run against anything but a local Supabase.
 */
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

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

  const packages = [
    { name: "Daily 5 Mbps", download_mbps: 5, upload_mbps: 5, price: 80, billing_period: "daily", duration_days: 1 },
    { name: "Weekly 8 Mbps", download_mbps: 8, upload_mbps: 8, price: 450, billing_period: "weekly", duration_days: 7 },
    { name: "Home 10 Mbps", download_mbps: 10, upload_mbps: 10, price: 2000, billing_period: "monthly", duration_days: null },
    { name: "Home 20 Mbps", download_mbps: 20, upload_mbps: 20, price: 3000, billing_period: "monthly", duration_days: null },
    { name: "Business 50 Mbps", download_mbps: 50, upload_mbps: 50, price: 7500, billing_period: "monthly", duration_days: null },
  ];
  for (const p of packages) {
    await db.from("service_packages").upsert({ tenant_id: mwangaza, description: "Fictional demo package", ...p }, { onConflict: "tenant_id,name" });
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
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
