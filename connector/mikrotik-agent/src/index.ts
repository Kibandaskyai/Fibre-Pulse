#!/usr/bin/env node
/**
 * FibrePulse Connector Agent for MikroTik RouterOS.
 *   node dist/index.js          run continuously
 *   node dist/index.js --once   one sync, poll and report, then exit
 * Settings come from environment variables (see .env.example).
 */
import { Agent, AGENT_VERSION } from "./agent.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

async function main() {
  // Read .env from the working directory if present. Variables already set
  // (systemd, Docker --env-file) take precedence.
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env file: settings come from the environment
  }
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    log("error", (e as Error).message);
    process.exit(2);
  }
  log("info", "FibrePulse connector starting", {
    version: AGENT_VERSION, cloud: cfg.cloudUrl, writes: cfg.allowWrites, simulate: cfg.simulate,
    localCredentials: Object.keys(cfg.localCredentials).length,
  });
  const agent = new Agent(cfg);
  if (process.argv.includes("--once")) {
    await agent.runOnce();
    log("info", "done", { routers: agent.routers().length });
    return;
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log("info", "stopping");
      agent.stop();
    });
  }
  await agent.run();
}

main().catch((e) => {
  log("error", "connector crashed", { error: (e as Error).message });
  process.exit(1);
});
