/**
 * Network data for the NOC, router pages, alerts and customer profiles.
 * Read and written as the signed-in user (RLS applies). Router passwords are
 * encrypted before they leave this server and can never be read back.
 */
import { randomBytes, createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CREDENTIAL_KEY_VERSION, encryptSecret } from "@/lib/connector/credentials";
import type { RouterInput } from "@/lib/validation/network";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
type DataSource = "simulated" | "manual" | "connector" | "provider";

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>, fallback: string): Promise<Result<T>> {
  const { data, error } = await db.rpc(fn, args);
  if (error) return { ok: false, message: friendlyDbError(error, fallback) };
  return { ok: true, data: data as T };
}

/** Run the watchdog (stale connectors, unanswered commands, retention). Cheap: once a minute per ISP. */
export async function runWatchdog(db: SupabaseClient, tenantId: string) {
  await db.rpc("network_watchdog", { p_tenant: tenantId });
}

// -----------------------------------------------------------------------------
// Routers
// -----------------------------------------------------------------------------
export type RouterRow = {
  id: string; name: string; model: string | null; identity: string | null; routeros_version: string | null;
  management_address: string | null; api_port: number | null; api_scheme: "https" | "http"; verify_tls: boolean;
  location_name: string | null; latitude: number | null; longitude: number | null; status: "online" | "offline" | "unknown";
  monitoring_enabled: boolean; last_synced_at: string | null; last_sync_error: string | null; uptime_seconds: number | null;
  cpu_load_pct: number | null; memory_used_pct: number | null; data_source: DataSource; connector_agent_id: string | null;
  serial_number: string | null; coverage_radius_m: number | null; connector: { name: string; last_seen_at: string | null } | null;
  sessions: number; has_credentials: boolean; credential_user: string | null;
};

const ROUTER_COLUMNS =
  "id, name, model, identity, routeros_version, management_address, api_port, api_scheme, verify_tls, location_name, latitude, longitude, status, monitoring_enabled, last_synced_at, last_sync_error, uptime_seconds, cpu_load_pct, memory_used_pct, data_source, connector_agent_id, serial_number, coverage_radius_m, connector_agents(name, last_seen_at)";

export async function listRouters(db: SupabaseClient, tenantId: string): Promise<RouterRow[]> {
  const [routers, sessions, creds] = await Promise.all([
    db.from("routers").select(ROUTER_COLUMNS).eq("tenant_id", tenantId).order("name"),
    db.from("network_sessions").select("router_id").eq("tenant_id", tenantId).is("ended_at", null),
    db.rpc("router_credential_status", { p_tenant: tenantId }),
  ]);
  const count = new Map<string, number>();
  for (const s of sessions.data ?? []) count.set(s.router_id, (count.get(s.router_id) ?? 0) + 1);
  const cred = new Map(((creds.data ?? []) as { router_id: string; username: string }[]).map((c) => [c.router_id, c.username]));
  return ((routers.data ?? []) as unknown as (Omit<RouterRow, "sessions" | "has_credentials" | "credential_user" | "connector"> & { connector_agents: RouterRow["connector"] })[]).map(
    ({ connector_agents, ...r }) => ({
      ...r,
      cpu_load_pct: n(r.cpu_load_pct),
      memory_used_pct: n(r.memory_used_pct),
      uptime_seconds: n(r.uptime_seconds),
      latitude: n(r.latitude),
      longitude: n(r.longitude),
      connector: connector_agents,
      sessions: count.get(r.id) ?? 0,
      has_credentials: cred.has(r.id),
      credential_user: cred.get(r.id) ?? null,
    }),
  );
}

export async function getRouter(db: SupabaseClient, tenantId: string, id: string) {
  const routers = await listRouters(db, tenantId);
  const router = routers.find((r) => r.id === id);
  if (!router) return null;
  const [interfaces, sessions, alerts] = await Promise.all([
    db.from("router_interfaces").select("id, name, interface_type, mac_address, running, disabled, rx_bps, tx_bps, last_seen_at, data_source").eq("router_id", id).order("name"),
    db
      .from("network_sessions")
      .select("id, session_type, username, ip_address, caller_id, started_at, last_seen_at, customer_id, customers(full_name, customer_number)")
      .eq("router_id", id)
      .is("ended_at", null)
      .order("username")
      .limit(500),
    db.from("network_alerts").select("id, severity, status, title, message, opened_at, resolved_at, data_source").eq("router_id", id).order("opened_at", { ascending: false }).limit(20),
  ]);
  return {
    router,
    interfaces: (interfaces.data ?? []).map((i) => ({ ...i, rx_bps: n(i.rx_bps), tx_bps: n(i.tx_bps) })) as {
      id: string; name: string; interface_type: string | null; mac_address: string | null; running: boolean | null; disabled: boolean | null;
      rx_bps: number | null; tx_bps: number | null; last_seen_at: string | null; data_source: DataSource;
    }[],
    sessions: (sessions.data ?? []) as unknown as {
      id: string; session_type: "pppoe" | "hotspot"; username: string; ip_address: string | null; caller_id: string | null; started_at: string;
      last_seen_at: string; customer_id: string | null; customers: { full_name: string; customer_number: string } | null;
    }[],
    alerts: (alerts.data ?? []) as AlertRow[],
  };
}

function routerRow(tenantId: string, input: RouterInput) {
  return {
    tenant_id: tenantId,
    name: input.name,
    management_address: input.managementAddress,
    api_port: input.apiPort,
    api_scheme: input.apiScheme,
    verify_tls: input.verifyTls,
    connector_agent_id: input.connectorAgentId,
    location_name: input.locationName,
    latitude: input.latitude,
    longitude: input.longitude,
    monitoring_enabled: input.monitoringEnabled,
    coverage_radius_m: input.coverageRadiusM,
  };
}

const duplicateRouter = (error: { code?: string; message?: string }, fallback: string) =>
  error.code === "23505" ? "Another router already has that name." : friendlyDbError(error, fallback);

export async function createRouter(db: SupabaseClient, tenantId: string, input: RouterInput): Promise<Result<{ id: string }>> {
  const { data, error } = await db.from("routers").insert({ ...routerRow(tenantId, input), data_source: "manual" }).select("id").single();
  if (error) return { ok: false, message: duplicateRouter(error, "Could not add the router.") };
  return { ok: true, data: { id: data.id } };
}

export async function updateRouter(db: SupabaseClient, tenantId: string, id: string, input: RouterInput): Promise<Result<null>> {
  const { data, error } = await db.from("routers").update(routerRow(tenantId, input)).eq("tenant_id", tenantId).eq("id", id).select("id");
  if (error) return { ok: false, message: duplicateRouter(error, "Could not save the router.") };
  if (!data?.length) return { ok: false, message: "Router not found or you cannot change it." };
  return { ok: true, data: null };
}

export function setRouterCredentials(db: SupabaseClient, routerId: string, username: string, password: string) {
  return rpc<null>(db, "set_router_credentials", { p_router: routerId, p_username: username, p_ciphertext: encryptSecret(password), p_key_version: CREDENTIAL_KEY_VERSION }, "Could not save the credentials.");
}

export async function routerHistory(db: SupabaseClient, routerId: string, hours = 24) {
  const { data } = await db.rpc("router_history", { p_router: routerId, p_hours: hours });
  return ((data ?? []) as { bucket: string; cpu: number | null; memory: number | null; sessions: number | null; reachable: number | null }[]).map((r) => ({
    bucket: r.bucket, cpu: n(r.cpu), memory: n(r.memory), sessions: n(r.sessions), reachable: n(r.reachable),
  }));
}

export async function networkTraffic(db: SupabaseClient, tenantId: string, hours = 24, routerId?: string) {
  const { data } = await db.rpc("network_traffic", { p_tenant: tenantId, p_hours: hours, p_router: routerId ?? null });
  return ((data ?? []) as { bucket: string; rx_bps: number | null; tx_bps: number | null }[]).map((r) => ({ bucket: r.bucket, rx_bps: n(r.rx_bps) ?? 0, tx_bps: n(r.tx_bps) ?? 0 }));
}

// -----------------------------------------------------------------------------
// Connectors
// -----------------------------------------------------------------------------
export type ConnectorRow = { id: string; name: string; token_prefix: string; status: "pending" | "active" | "revoked"; last_seen_at: string | null; agent_version: string | null; created_at: string; routers: number };

export async function listConnectors(db: SupabaseClient, tenantId: string): Promise<ConnectorRow[]> {
  const [agents, routers] = await Promise.all([
    db.from("connector_agents").select("id, name, token_prefix, status, last_seen_at, agent_version, created_at").eq("tenant_id", tenantId).order("created_at"),
    db.from("routers").select("connector_agent_id").eq("tenant_id", tenantId),
  ]);
  const count = new Map<string, number>();
  for (const r of routers.data ?? []) if (r.connector_agent_id) count.set(r.connector_agent_id, (count.get(r.connector_agent_id) ?? 0) + 1);
  return ((agents.data ?? []) as Omit<ConnectorRow, "routers">[]).map((a) => ({ ...a, routers: count.get(a.id) ?? 0 }));
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function newConnectorToken(): { token: string; hash: string; prefix: string } {
  const bytes = randomBytes(40);
  const token = "fpc_" + Array.from(bytes, (b) => BASE62[b % 62]).join("");
  return { token, hash: createHash("sha256").update(token).digest("hex"), prefix: token.slice(0, 12) };
}

/** Registers a connector and returns its token. The token is shown once and only its hash is stored. */
export async function createConnector(db: SupabaseClient, tenantId: string, userId: string, name: string): Promise<Result<{ id: string; token: string }>> {
  const t = newConnectorToken();
  const { data, error } = await db
    .from("connector_agents")
    .insert({ tenant_id: tenantId, name, token_hash: t.hash, token_prefix: t.prefix, created_by: userId })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.code === "23505" ? "A connector with that name already exists." : friendlyDbError(error, "Could not register the connector.") };
  return { ok: true, data: { id: data.id, token: t.token } };
}

export async function revokeConnector(db: SupabaseClient, tenantId: string, id: string): Promise<Result<null>> {
  const { data, error } = await db.from("connector_agents").update({ status: "revoked" }).eq("tenant_id", tenantId).eq("id", id).select("id");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not revoke the connector.") };
  if (!data?.length) return { ok: false, message: "Connector not found." };
  return { ok: true, data: null };
}

// -----------------------------------------------------------------------------
// Alerts
// -----------------------------------------------------------------------------
export type AlertRow = {
  id: string; severity: "info" | "warning" | "critical"; status: "open" | "acknowledged" | "resolved"; title: string; message: string | null;
  opened_at: string; resolved_at: string | null; data_source: DataSource; alert_type?: string; router_id?: string | null;
  routers?: { name: string } | null; acknowledged_at?: string | null;
};

export async function listAlerts(db: SupabaseClient, tenantId: string, f: { status: string; severity: string; page: number }, pageSize = 25) {
  let q = db
    .from("network_alerts")
    .select("id, severity, status, title, message, opened_at, acknowledged_at, resolved_at, data_source, alert_type, router_id, routers(name)", { count: "exact" })
    .eq("tenant_id", tenantId);
  if (f.status === "active") q = q.neq("status", "resolved");
  else if (["open", "acknowledged", "resolved"].includes(f.status)) q = q.eq("status", f.status);
  if (["info", "warning", "critical"].includes(f.severity)) q = q.eq("severity", f.severity);
  const from = (f.page - 1) * pageSize;
  const { data, count } = await q.order("opened_at", { ascending: false }).range(from, from + pageSize - 1);
  return { rows: (data ?? []) as unknown as AlertRow[], total: count ?? 0 };
}

export const updateAlert = (db: SupabaseClient, id: string, action: "acknowledge" | "resolve", note: string | null) =>
  rpc<null>(db, "update_alert", { p_alert: id, p_action: action, p_note: note }, "Could not update the alert.");

// -----------------------------------------------------------------------------
// NOC summary
// -----------------------------------------------------------------------------
export async function networkSummary(db: SupabaseClient, tenantId: string) {
  const [routers, sessions, alerts, agents, subs] = await Promise.all([
    db.from("routers").select("status, data_source").eq("tenant_id", tenantId),
    db.from("network_sessions").select("session_type, customer_id, data_source").eq("tenant_id", tenantId).is("ended_at", null),
    db.from("network_alerts").select("severity, data_source").eq("tenant_id", tenantId).neq("status", "resolved"),
    db.from("connector_agents").select("status, last_seen_at").eq("tenant_id", tenantId).neq("status", "revoked"),
    db.from("subscriptions").select("customer_id").eq("tenant_id", tenantId).eq("status", "active"),
  ]);
  const r = routers.data ?? [];
  const s = sessions.data ?? [];
  const a = alerts.data ?? [];
  const ag = agents.data ?? [];
  const online = new Set(s.filter((x) => x.customer_id).map((x) => x.customer_id));
  const activeCustomers = new Set((subs.data ?? []).map((x) => x.customer_id));
  const fresh = (t: string | null) => !!t && Date.now() - Date.parse(t) < 3 * 60_000;
  return {
    routers: r.length,
    online: r.filter((x) => x.status === "online").length,
    offline: r.filter((x) => x.status === "offline").length,
    unknown: r.filter((x) => x.status === "unknown").length,
    simulatedRouters: r.filter((x) => x.data_source === "simulated").length,
    pppoe: s.filter((x) => x.session_type === "pppoe").length,
    hotspot: s.filter((x) => x.session_type === "hotspot").length,
    simulatedSessions: s.filter((x) => x.data_source === "simulated").length,
    customersOnline: [...activeCustomers].filter((c) => online.has(c)).length,
    customersOffline: [...activeCustomers].filter((c) => !online.has(c)).length,
    activeCustomers: activeCustomers.size,
    critical: a.filter((x) => x.severity === "critical").length,
    warning: a.filter((x) => x.severity === "warning").length,
    openAlerts: a.length,
    connectors: ag.length,
    connectorsReporting: ag.filter((x) => fresh(x.last_seen_at)).length,
  };
}

// -----------------------------------------------------------------------------
// Customer connection and router enforcement
// -----------------------------------------------------------------------------
export type CommandRow = {
  id: string; command_type: "disconnect_pppoe" | "reconnect_pppoe"; status: string; result_message: string | null; reason: string | null;
  created_at: string; completed_at: string | null; attempts: number; routers: { name: string } | null;
};

export async function customerConnection(db: SupabaseClient, tenantId: string, customerId: string, canSeeNetwork: boolean) {
  const [customer, sessions, lastSession, commands] = await Promise.all([
    db.from("customers").select("router_id, pppoe_username, routers(name, status)").eq("tenant_id", tenantId).eq("id", customerId).maybeSingle(),
    canSeeNetwork
      ? db.from("network_sessions").select("id, session_type, username, ip_address, started_at, last_seen_at, data_source, routers(name)").eq("tenant_id", tenantId).eq("customer_id", customerId).is("ended_at", null)
      : Promise.resolve({ data: null }),
    canSeeNetwork
      ? db.from("network_sessions").select("ended_at, started_at").eq("tenant_id", tenantId).eq("customer_id", customerId).not("ended_at", "is", null).order("ended_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from("router_commands").select("id, command_type, status, result_message, reason, created_at, completed_at, attempts, routers(name)").eq("tenant_id", tenantId).eq("customer_id", customerId).order("created_at", { ascending: false }).limit(5),
  ]);
  return {
    routerId: (customer.data?.router_id as string | null) ?? null,
    router: (customer.data?.routers as unknown as { name: string; status: string } | null) ?? null,
    pppoeUsername: (customer.data?.pppoe_username as string | null) ?? null,
    sessions: (sessions.data ?? null) as
      | { id: string; session_type: string; username: string; ip_address: string | null; started_at: string; last_seen_at: string; data_source: DataSource; routers: { name: string } | null }[]
      | null,
    lastEnded: (lastSession.data as { ended_at: string } | null)?.ended_at ?? null,
    commands: (commands.data ?? []) as unknown as CommandRow[],
  };
}

export const assignCustomerRouter = (db: SupabaseClient, customerId: string, routerId: string | null) =>
  rpc<null>(db, "assign_customer_router", { p_customer: customerId, p_router: routerId }, "Could not set the router.");

export const retryRouterCommand = (db: SupabaseClient, id: string) => rpc<null>(db, "retry_router_command", { p_command: id }, "Could not retry the command.");

export const setRouterEnforcement = (db: SupabaseClient, tenantId: string, enabled: boolean) =>
  rpc<null>(db, "set_router_enforcement", { p_tenant: tenantId, p_enabled: enabled }, "Could not change the setting.");

export const setAccessControl = (db: SupabaseClient, tenantId: string, mode: "router_secrets" | "radius") =>
  rpc<null>(db, "set_access_control", { p_tenant: tenantId, p_mode: mode }, "Could not change the setting.");

export async function routerEnforcementEnabled(db: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data } = await db.from("tenants").select("settings").eq("id", tenantId).maybeSingle();
  return Boolean((data?.settings as { router_enforcement?: boolean } | null)?.router_enforcement);
}

/** The router command (if any) that a subscription change just queued, for the confirmation message. */
export async function commandQueuedSince(db: SupabaseClient, subscriptionId: string, sinceIso: string) {
  const { data } = await db
    .from("router_commands")
    .select("command_type, status, result_message")
    .eq("subscription_id", subscriptionId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { command_type: CommandRow["command_type"]; status: string; result_message: string | null } | null) ?? null;
}

/** Plain-language result of suspending or restoring, depending on what the router enforcement did. */
export function enforcementMessage(action: "suspend" | "restore", cmd: { status: string; result_message: string | null } | null, enforcement: boolean): string {
  const verb = action === "suspend" ? "disconnect" : "reconnect";
  if (!enforcement) {
    return action === "suspend"
      ? "Subscription suspended. Disconnecting on the router is turned off for your ISP, so also disconnect the customer on the router yourself."
      : "Subscription restored. Disconnecting on the router is turned off, so reconnect the customer on the router yourself if needed.";
  }
  if (!cmd) return action === "suspend" ? "Subscription suspended." : "Subscription restored.";
  if (cmd.status === "blocked") return `${action === "suspend" ? "Suspended" : "Restored"}, but FibrePulse could not ${verb} them on the router: ${cmd.result_message ?? "missing details"}`;
  return `${action === "suspend" ? "Suspended" : "Restored"}. The connector will ${verb} them on the router within a minute.`;
}

/** Router availability over the last hours, real devices only, plus the simulated figure kept apart. */
export async function networkAvailability(db: SupabaseClient, tenantId: string, hours = 24) {
  const { data } = await db.rpc("network_availability", { p_tenant: tenantId, p_hours: hours });
  const rows = (data ?? []) as { data_source: DataSource; availability_pct: number | null; samples: number }[];
  const real = rows.filter((r) => r.data_source !== "simulated");
  const realSamples = real.reduce((s, r) => s + Number(r.samples), 0);
  const realPct = realSamples ? real.reduce((s, r) => s + Number(r.availability_pct) * Number(r.samples), 0) / realSamples : null;
  const sim = rows.find((r) => r.data_source === "simulated");
  return { real: realPct === null ? null : Math.round(realPct * 10) / 10, simulated: sim ? Number(sim.availability_pct) : null };
}
