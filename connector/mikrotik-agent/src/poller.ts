/** Read one router and turn RouterOS rows into a FibrePulse reading. */
import { bool, num, parseDuration, RouterOsClient, RouterOsError, type Row } from "./routeros.js";

export type Counters = Map<string, { rx: number; tx: number; at: number }>;

export type Reading = {
  router_id: string;
  collected_at: string;
  reachable: boolean;
  skipped?: boolean;
  error?: string;
  system?: { identity: string | null; model: string | null; serial_number: string | null; version: string | null; uptime_seconds: number | null; cpu_load_pct: number | null; memory_used_pct: number | null };
  interfaces?: { name: string; type: string | null; mac_address: string | null; running: boolean | null; disabled: boolean | null; rx_bps: number | null; tx_bps: number | null }[];
  sessions?: { type: "pppoe" | "hotspot"; username: string; address: string | null; caller_id: string | null; uptime_seconds: number | null; bytes_in?: number | null; bytes_out?: number | null }[];
  warnings?: string[];
};

const rows = (v: Row[] | Row | null): Row[] => (Array.isArray(v) ? v : v ? [v] : []);

/** bits per second from two byte counters; null after a counter reset or on the first poll. */
export function rate(prev: number | undefined, curr: number | null, seconds: number): number | null {
  if (prev === undefined || curr === null || seconds <= 0 || curr < prev) return null;
  return Math.round(((curr - prev) * 8) / seconds);
}

export async function pollRouter(routerId: string, client: RouterOsClient, counters: Counters, now = () => Date.now()): Promise<Reading> {
  const at = now();
  const collected_at = new Date(at).toISOString();
  const warnings: string[] = [];
  let resource: Row;
  try {
    resource = rows(await client.get("/system/resource"))[0] ?? {};
  } catch (e) {
    return { router_id: routerId, collected_at, reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
  // Optional reads: a failure here is a warning, not an outage.
  const optional = async (path: string): Promise<Row[] | null> => {
    try {
      return rows(await client.get(path));
    } catch (e) {
      if (!(e instanceof RouterOsError && e.status === 404)) warnings.push(`${path}: ${(e as Error).message}`);
      return null;
    }
  };
  const [identity, board, ifaces, ppp, hotspot] = await Promise.all([
    optional("/system/identity"),
    optional("/system/routerboard"),
    optional("/interface"),
    optional("/ppp/active"),
    optional("/ip/hotspot/active"),
  ]);

  const total = num(resource["total-memory"]);
  const free = num(resource["free-memory"]);
  const reading: Reading = {
    router_id: routerId,
    collected_at,
    reachable: true,
    system: {
      identity: identity?.[0]?.name ?? null,
      model: board?.[0]?.model ?? resource["board-name"] ?? null,
      serial_number: board?.[0]?.["serial-number"] ?? null,
      version: resource.version ?? null,
      uptime_seconds: parseDuration(resource.uptime),
      cpu_load_pct: num(resource["cpu-load"]),
      memory_used_pct: total && free !== null ? Math.round(((total - free) / total) * 1000) / 10 : null,
    },
  };

  if (ifaces) {
    reading.interfaces = ifaces.slice(0, 128).map((i) => {
      const name = i.name ?? "";
      const rx = num(i["rx-byte"]);
      const tx = num(i["tx-byte"]);
      const prev = counters.get(name);
      const seconds = prev ? (at - prev.at) / 1000 : 0;
      if (rx !== null && tx !== null) counters.set(name, { rx, tx, at });
      return {
        name,
        type: i.type ?? null,
        mac_address: i["mac-address"] ?? null,
        running: bool(i.running),
        disabled: bool(i.disabled),
        rx_bps: rate(prev?.rx, rx, seconds),
        tx_bps: rate(prev?.tx, tx, seconds),
      };
    }).filter((i) => i.name);
  }

  // Sessions are only sent when both lists could be read (or do not exist),
  // so a failed read never ends everyone's sessions.
  if (ppp !== null || hotspot !== null) {
    if (!warnings.some((w) => w.startsWith("/ppp/active") || w.startsWith("/ip/hotspot/active"))) {
      reading.sessions = [
        ...(ppp ?? []).filter((s) => s.name).map((s) => ({
          type: "pppoe" as const,
          username: s.name!,
          address: s.address ?? null,
          caller_id: s["caller-id"] ?? null,
          uptime_seconds: parseDuration(s.uptime),
        })),
        ...(hotspot ?? []).filter((s) => s.user).map((s) => ({
          type: "hotspot" as const,
          username: s.user!,
          address: s.address ?? null,
          caller_id: s["mac-address"] ?? null,
          uptime_seconds: parseDuration(s.uptime),
          bytes_in: num(s["bytes-in"]),
          bytes_out: num(s["bytes-out"]),
        })),
      ];
    }
  }
  if (warnings.length) reading.warnings = warnings;
  return reading;
}
