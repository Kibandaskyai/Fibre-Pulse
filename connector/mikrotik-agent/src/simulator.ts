/**
 * SIMULATED readings for routers that FibrePulse marks as simulated test
 * devices. FibrePulse stores them with data_source = 'simulated' and labels
 * them in every screen; real routers refuse simulated data.
 */
import type { Reading } from "./poller.js";

const state = new Map<string, { cpu: number; mem: number; uptime: number; seed: number }>();

function rnd(seed: number) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export function simulateReading(routerId: string, name: string, now = Date.now(), opts: { upstreamDown?: boolean } = {}): Reading {
  const seed = [...routerId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100000;
  const s = state.get(routerId) ?? { cpu: 8 + (seed % 25), mem: 25 + (seed % 30), uptime: 86400 * (1 + (seed % 20)), seed };
  s.seed += 1;
  s.cpu = Math.min(85, Math.max(3, s.cpu + (rnd(s.seed) - 0.5) * 10));
  s.mem = Math.min(80, Math.max(20, s.mem + (rnd(s.seed + 7) - 0.5) * 4));
  s.uptime += 60;
  state.set(routerId, s);
  const hour = new Date(now).getUTCHours() + 3;
  const evening = hour % 24 >= 18 && hour % 24 <= 23 ? 2.2 : 1;
  const sessions = Array.from({ length: 6 + Math.round(rnd(s.seed + 3) * 4) }, (_, i) => ({
    type: "pppoe" as const,
    username: `sim-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 12)}-${String(i + 1).padStart(2, "0")}`,
    address: `10.99.${i}.${10 + i}`,
    caller_id: null,
    uptime_seconds: 3600 * (i + 1),
  }));
  // Hotspot users: phones and gadgets on time codes (SIMULATED names).
  const hotspot = Array.from({ length: Math.round((40 + rnd(s.seed + 9) * 30) * evening) }, (_, i) => ({
    type: "hotspot" as const,
    username: `sim-hs-${String(i + 1).padStart(3, "0")}`,
    address: `10.5.${50 + Math.floor(i / 200)}.${(i % 200) + 10}`,
    caller_id: `02:51:4D:00:${((seed + i) >> 8 & 255).toString(16).padStart(2, "0").toUpperCase()}:${((seed + i) & 255).toString(16).padStart(2, "0").toUpperCase()}`,
    uptime_seconds: 600 + i * 37,
    bytes_in: 1_000_000 * (i + 1),
    bytes_out: 8_000_000 * (i + 1),
  }));
  return {
    router_id: routerId,
    upstream: opts.upstreamDown
      ? { target: "8.8.8.8", reachable: false, loss_pct: 100, avg_ms: null }
      : { target: "8.8.8.8", reachable: true, loss_pct: 0, avg_ms: Math.round(14 + rnd(s.seed + 11) * 20) },
    collected_at: new Date(now).toISOString(),
    reachable: true,
    system: { identity: `SIM ${name}`, model: "SIMULATED", serial_number: null, version: "7.x (simulated)", uptime_seconds: s.uptime, cpu_load_pct: Math.round(s.cpu), memory_used_pct: Math.round(s.mem) },
    interfaces: [
      { name: "sfp-uplink", type: "ether", mac_address: null, running: true, disabled: false, rx_bps: Math.round(80e6 * evening * (0.7 + rnd(s.seed + 1) * 0.6)), tx_bps: Math.round(12e6 * evening * (0.7 + rnd(s.seed + 2) * 0.6)) },
      { name: "ether2-lan", type: "ether", mac_address: null, running: true, disabled: false, rx_bps: Math.round(10e6 * evening * rnd(s.seed + 4)), tx_bps: Math.round(60e6 * evening * rnd(s.seed + 5)) },
      { name: "ether5-spare", type: "ether", mac_address: null, running: false, disabled: false, rx_bps: 0, tx_bps: 0 },
    ],
    sessions: [...sessions, ...hotspot],
  };
}
