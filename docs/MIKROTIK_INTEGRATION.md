# MikroTik integration (Phase 4)

FibrePulse reads MikroTik routers through the **FibrePulse Connector Agent** (`connector/mikrotik-agent/`), a small Node.js program that runs on a computer **inside the ISP network**. The connector talks to routers locally over the RouterOS v7 REST API and reports to FibrePulse **outbound** over HTTPS. Router management ports are never opened to the internet.

```
MikroTik routers  <--REST (LAN)--  Connector agent  --HTTPS, signed-->  FibrePulse /api/connector/v1/*  -->  Postgres functions
```

## What it does

| Every | The connector | FibrePulse |
|---|---|---|
| 15 s (`SYNC_INTERVAL_SECONDS`) | `POST /sync`: gets its router list, decrypted API credentials and any queued commands | marks the connector active; clears "connector offline" |
| 60 s (`POLL_INTERVAL_SECONDS`) | reads each router (4 at a time): `/system/resource`, `/system/identity`, `/system/routerboard`, `/interface`, `/ppp/active`, `/ip/hotspot/active`; computes bit rates from counter deltas; `POST /ingest` | updates status, CPU, memory, uptime, interfaces, sessions; writes metrics; links PPPoE sessions to customers by `pppoe_username` (and learns the customer's router); opens/clears alerts |
| command | runs a disconnect/reconnect, `POST /commands` with the result | updates the command, alerts on failure |

If FibrePulse is unreachable the connector keeps up to 120 batches in memory and retries with backoff (5 s to 5 min).

## Alerts raised automatically

| Alert | Severity | Raised when | Clears when |
|---|---|---|---|
| Router offline | critical | 2 consecutive failed reads | the router answers |
| High CPU / memory | warning | ≥ 90% | below 80% |
| Connector offline | critical | no contact for 5 minutes (checked by the watchdog when anyone opens a network page) | the connector syncs |
| Disconnect/reconnect failed | warning | the router refused the change | manual resolve |

Alerts are de-duplicated (one open alert per problem) and notify members with `alerts:manage` in the app. A router whose connector stops reporting becomes **Unknown**, not Offline.

## Installing for the pilot ISP

1. **RouterOS 7.1 or later** on each router (the REST API does not exist on v6; v6 support would need the classic API and is not built).
2. Enable the HTTPS service (`/ip service enable www-ssl`) with a certificate, and restrict it to the connector's address: `/ip service set www-ssl address=<connector-ip>/32`.
3. Create a group and user just for FibrePulse:
   ```
   /user group add name=fibrepulse-ro policy=read,api,rest-api
   /user add name=fibrepulse group=fibrepulse-ro password=<long random> address=<connector-ip>/32
   ```
   Only if the owner turns on router disconnect, give the group write as well:
   `/user group set fibrepulse-ro policy=read,write,api,rest-api`
4. In FibrePulse: **Network Monitoring → Connectors → Register connector**. Copy the token (shown once).
5. On the connector machine (Node 20+, or Docker):
   ```
   cd connector/mikrotik-agent && npm install && npm run build
   cp .env.example .env   # set FIBREPULSE_URL and FIBREPULSE_TOKEN
   npm start              # or: docker build -t fibrepulse-agent . ; or the systemd unit
   ```
6. **Add router** for each MikroTik (management IP as the connector sees it, HTTPS, connector), then save its API username and password on the router page.

Router passwords can instead stay only on the connector machine: set `ROUTER_CREDENTIALS_FILE` to a JSON file `{ "<router id>": { "username": "...", "password": "..." } }` and leave them out of FibrePulse.

## Disconnecting suspended customers

Required by the pilot ISP (23 Nov 2026). Three switches must all be on, so it can never happen by accident:

1. The **owner** turns on *Settings → Organisation → Disconnect suspended customers on the router* (audited).
2. The connector runs with `ALLOW_ROUTER_WRITES=true`.
3. The router user has the `write` policy.

Then suspending a subscription queues `disconnect_pppoe`: the connector sets `/ppp/secret` `disabled=yes` for the customer's PPPoE username and removes their `/ppp/active` session. Restoring queues `reconnect_pppoe` (`disabled=no`). If a disconnect was still queued when the customer is restored, it is cancelled instead. Nothing else on the router is ever changed. The customer profile shows each command and its result; failed, blocked or expired ones can be retried by the owner.

A command is **blocked** (and the profile says why) when the customer has no PPPoE username or FibrePulse does not know their router yet. The router is learned from the customer's first session or set on the profile. Sent commands with no answer after 10 minutes are re-sent (3 attempts); queued commands expire after 24 hours.

**Limits for the engineer:** expiry and cancellation do not disconnect (ask the ISP). Hotspot users are not disconnected. If the ISP uses **RADIUS**, PPPoE secrets are not on the router, so disconnect must be done in RADIUS (CoA/disable user) instead; `connector/mikrotik-agent/src/commands.ts` is the place to add it.

## Not measured

Wi-Fi quality and optical (ONU/ONT) power need CPE (TR-069) or OLT telemetry. The NOC says "not measured" instead of showing numbers.

## Local demo

`npm run db:seed` registers a "Demo simulator" connector for the two simulated routers and writes its token to `connector/mikrotik-agent/.env` (git-ignored). With the app running, `npm run connector:demo` (add `-- --once` for one cycle) reports SIMULATED readings. Simulated data is accepted only for routers marked simulated, is labelled everywhere, and is excluded from availability figures.
