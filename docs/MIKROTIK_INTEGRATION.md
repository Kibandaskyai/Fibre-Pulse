# MikroTik integration (planned for Phase 4)

## Design

- A separate **FibrePulse Connector Agent** (Node.js, `connector/mikrotik-agent/`) runs inside the ISP network.
- It talks to routers locally with **read-only** RouterOS users over the RouterOS v7 REST API (`/rest/...`), falling back to the classic API (8728/8729) for v6 routers.
- It pushes telemetry **outbound** over HTTPS to `POST /api/connector/ingest`, authenticated with its registration token (stored in FibrePulse only as a SHA-256 hash) plus an HMAC signature per request.
- It buffers locally and retries with backoff during outages; missed polls show as "unknown", not "offline", until a threshold is crossed.
- Router management ports are never exposed to the internet.

## Data model (already in place)

`connector_agents`, `routers`, `router_credentials` (encrypted, unreadable by users), `router_interfaces`, `network_sessions`, `network_metrics`, `network_alerts`, each with `data_source`.

## What the pilot ISP must provide

- RouterOS version on each router (REST needs v7.1+).
- A read-only API user per router (`/user group add name=fibrepulse-ro policy=read,api,rest-api`).
- A machine (or container host) inside the network for the agent, with outbound HTTPS.
- Whether customers use PPPoE, hotspot or both, and whether a RADIUS server is used.

## Explicit limits

- No write or destructive router commands without explicit, separate authorisation.
- Required by the pilot ISP (23 Nov 2026): suspending a subscription disconnects the customer (disable their PPPoE secret and remove the active session); restoring re-enables it. Build as a queued, audited command the connector picks up, enabled per ISP, with the result shown on the customer profile.
- No Wi-Fi or optical signal readings unless CPE (TR-069) or OLT/ONT telemetry is connected. The UI will say so instead of showing numbers.
