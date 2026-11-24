/**
 * The connector loop: sync configuration and commands, poll routers, send
 * readings, buffer them while FibrePulse is unreachable, back off on errors.
 */
import { CloudClient, CloudError, type Command, type RouterConfig, type SyncResponse } from "./cloud.js";
import { runCommand } from "./commands.js";
import type { AgentConfig } from "./config.js";
import { log } from "./log.js";
import { pollRouter, type Counters, type Reading } from "./poller.js";
import { RouterOsClient } from "./routeros.js";
import { simulateReading } from "./simulator.js";

export const AGENT_VERSION = "0.4.0";

export class Agent {
  private cloud: CloudClient;
  private config: SyncResponse | null = null;
  private counters = new Map<string, Counters>();
  private buffer: { routers: Reading[]; simulated?: boolean }[] = [];
  private stopped = false;
  private cloudFailures = 0;

  constructor(private cfg: AgentConfig, cloud?: CloudClient) {
    this.cloud = cloud ?? new CloudClient(cfg.cloudUrl, cfg.token, cfg.requestTimeoutMs);
  }

  /** Routers this agent should poll in its mode (real or simulated). */
  routers(): RouterConfig[] {
    return (this.config?.routers ?? []).filter((r) => r.simulated === this.cfg.simulate);
  }

  private client(r: RouterConfig): RouterOsClient | string {
    const local = this.cfg.localCredentials[r.id];
    const username = local?.username ?? r.username;
    const password = local?.password ?? r.password;
    if (!r.address) return "No management address set in FibrePulse.";
    if (!username || !password) return r.credential_error ?? "No API username and password set (in FibrePulse or ROUTER_CREDENTIALS_FILE).";
    return new RouterOsClient({ address: r.address, port: r.port, scheme: r.scheme, verifyTls: r.verify_tls, username, password, timeoutMs: this.cfg.requestTimeoutMs });
  }

  async sync(): Promise<SyncResponse> {
    this.config = await this.cloud.sync(AGENT_VERSION);
    this.cloudFailures = 0;
    for (const cmd of this.config.commands) await this.execute(cmd);
    return this.config;
  }

  async execute(cmd: Command): Promise<void> {
    const r = (this.config?.routers ?? []).find((x) => x.id === cmd.router_id);
    let success = false;
    let message: string;
    if (!r) {
      message = "The router is not assigned to this connector.";
    } else if (r.simulated) {
      success = true;
      message = "SIMULATED router: nothing was changed.";
    } else if (!this.cfg.allowWrites) {
      message = "Router writes are turned off on this connector (set ALLOW_ROUTER_WRITES=true on the connector machine).";
    } else {
      const client = this.client(r);
      if (typeof client === "string") message = client;
      else {
        try {
          message = await runCommand(client, cmd.type, cmd.pppoe_username);
          success = true;
        } catch (e) {
          message = (e as Error).message;
        }
      }
    }
    log(success ? "info" : "warn", "router command", { command: cmd.id, type: cmd.type, router: cmd.router_id, success, message });
    try {
      await this.cloud.commandResult(cmd.id, success, message);
    } catch (e) {
      // The cloud re-queues unanswered commands after 10 minutes.
      log("warn", "could not report command result", { command: cmd.id, error: (e as Error).message });
    }
  }

  async pollAll(): Promise<Reading[]> {
    const routers = this.routers();
    const out: Reading[] = [];
    const queue = [...routers];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        if (this.cfg.simulate) {
          out.push(simulateReading(r.id, r.name));
          continue;
        }
        const client = this.client(r);
        if (typeof client === "string") {
          out.push({ router_id: r.id, collected_at: new Date().toISOString(), reachable: false, skipped: true, error: client });
          continue;
        }
        const counters = this.counters.get(r.id) ?? new Map();
        this.counters.set(r.id, counters);
        const reading = await pollRouter(r.id, client, counters);
        if (!reading.reachable) log("warn", "router unreachable", { router: r.name, error: reading.error });
        if (reading.warnings) log("warn", "partial router read", { router: r.name, warnings: reading.warnings });
        out.push(reading);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, routers.length) }, worker));
    const order = new Map(routers.map((r, i) => [r.id, i]));
    return out.sort((a, b) => order.get(a.router_id)! - order.get(b.router_id)!);
  }

  /** Send readings, oldest buffered batches first. Keeps them if FibrePulse is down. */
  async report(readings: Reading[]): Promise<void> {
    if (readings.length) this.buffer.push({ routers: readings, ...(this.cfg.simulate ? { simulated: true } : {}) });
    while (this.buffer.length > this.cfg.maxBufferedBatches) {
      this.buffer.shift();
      log("warn", "reading buffer full; dropped the oldest batch");
    }
    while (this.buffer.length) {
      const batch = this.buffer[0];
      try {
        const res = await this.cloud.ingest(batch);
        if (res.rejected.length) log("warn", "readings refused", { rejected: res.rejected });
        this.buffer.shift();
        this.cloudFailures = 0;
      } catch (e) {
        if (e instanceof CloudError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401) {
          log("error", "batch refused by FibrePulse; dropping it", { status: e.status, error: e.message });
          this.buffer.shift();
          continue;
        }
        this.cloudFailures += 1;
        log("warn", "FibrePulse unreachable; keeping readings", { buffered: this.buffer.length, error: (e as Error).message });
        return;
      }
    }
  }

  async runOnce(): Promise<void> {
    await this.sync();
    await this.report(await this.pollAll());
  }

  backoffMs(): number {
    return this.cloudFailures ? Math.min(300_000, 5_000 * 2 ** Math.min(this.cloudFailures - 1, 6)) : 0;
  }

  stop() {
    this.stopped = true;
  }

  async run(): Promise<void> {
    let nextPoll = 0;
    while (!this.stopped) {
      try {
        await this.sync();
      } catch (e) {
        this.cloudFailures += 1;
        log(e instanceof CloudError && e.status === 401 ? "error" : "warn", "sync failed", { error: (e as Error).message });
      }
      if (this.config && Date.now() >= nextPoll) {
        const interval = Math.max(15_000, (this.config.poll_interval_seconds ?? 60) * 1000, this.cfg.pollIntervalMs);
        nextPoll = Date.now() + interval;
        await this.report(await this.pollAll());
      }
      await sleep(Math.max(this.cfg.syncIntervalMs, this.backoffMs()), () => this.stopped);
    }
  }
}

function sleep(ms: number, stopped: () => boolean) {
  return new Promise<void>((resolve) => {
    const end = Date.now() + ms;
    const tick = () => (stopped() || Date.now() >= end ? resolve() : setTimeout(tick, Math.min(500, end - Date.now())));
    tick();
  });
}
