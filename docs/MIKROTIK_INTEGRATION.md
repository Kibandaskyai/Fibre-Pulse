# MikroTik integration (Phase 4, RADIUS in Phase 7)

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

## Disconnecting customers (suspended or package ended)

Required by the pilot ISP: suspension (23 Nov 2026) and a package running out without renewal (24 Nov 2026) both cut service. Three switches must all be on, so it can never happen by accident:

1. The **owner** turns on *Settings → Organisation → Disconnect customers who are suspended or whose package has ended* (audited).
2. The connector runs with `ALLOW_ROUTER_WRITES=true`.
3. The router user has the `write` policy.

What queues a `disconnect_pppoe` command:

- suspending a subscription;
- a package reaching its end date with no renewal. The database checks every 5 minutes (`pg_cron` job `fibrepulse-expire-subscriptions`). A package replaced early by a renewal, upgrade or downgrade never disconnects.

Restoring, renewing or buying a new package queues `reconnect_pppoe`. If a disconnect was still queued, it is cancelled instead. Cancellation does not disconnect (not decided by the ISP yet).

A command is **blocked** (and the profile says why) when the customer has no PPPoE username or FibrePulse does not know their router yet. The router is learned from the customer's first session or set on the profile. Sent commands with no answer after 10 minutes are re-sent (3 attempts); queued commands expire after 24 hours. Hotspot users are not disconnected.

### Access control: router secrets or RADIUS

The owner chooses under *Settings → Organisation → Access control*:

| Mode | Disconnect does | Reconnect does |
|---|---|---|
| PPPoE secrets on the MikroTik router (default) | `/ppp/secret disabled=yes` and removes the `/ppp/active` session | `/ppp/secret disabled=no` |
| RADIUS server (pilot ISP, 24 Nov 2026) | removes the `/ppp/active` session only | nothing on the router; RADIUS accepts the next dial-in |

## RADIUS

The pilot ISP authenticates PPPoE customers with RADIUS. FibrePulse decides **who may connect and at what speed**. The ISP's own RADIUS server (for example FreeRADIUS) still checks passwords, so **customer PPPoE passwords never leave the ISP's network**.

How it fits together:

1. On every sync (about every 15 seconds), FibrePulse sends the connector the list of PPPoE usernames. Each entry says whether the customer has a live package and gives its speeds. The list is sent only in RADIUS mode with disconnects turned on.
2. The connector keeps the list in memory and on disk (`RADIUS_CACHE_FILE`). It answers a local HTTP endpoint for FreeRADIUS. If the internet link to FibrePulse drops, the last list keeps working.
3. When a customer dials in, the MikroTik router asks RADIUS. FreeRADIUS checks the password, then asks the connector. The connector answers in one of three ways:
   - `200` with `Mikrotik-Rate-Limit` (upload/download from the package): accept.
   - `401`: reject, because there is no live package.
   - `404`: not a FibrePulse customer, so FreeRADIUS decides on its own (useful for staff or infrastructure accounts).
4. When FibrePulse disconnects a customer, the connector drops the live session. The router then asks RADIUS again, and RADIUS refuses.

Connector settings (`connector/mikrotik-agent/.env`):

```bash
RADIUS_POLICY_PORT=18120          # 0 = off
RADIUS_POLICY_HOST=10.0.0.5       # a LAN address FreeRADIUS can reach (default 127.0.0.1)
RADIUS_POLICY_SECRET=<at least 24 random characters>   # openssl rand -base64 32
RADIUS_CACHE_FILE=/var/lib/fibrepulse/radius.json
```

FreeRADIUS 3 (`mods-enabled/rest`). The secret goes as the HTTP Basic password; newer versions can send header `X-FibrePulse-Radius-Secret` instead. **Check these lines against the ISP's FreeRADIUS version before going live.**

```
rest fibrepulse {
    connect_uri = "http://10.0.0.5:18120"
    authorize {
        uri = "${..connect_uri}/radius/authorize"
        method = "post"
        body = "json"
        data = "{\"username\": \"%{User-Name}\"}"
        auth = "basic"
        username = "freeradius"
        password = "<RADIUS_POLICY_SECRET>"
    }
}
```

In `sites-enabled/default`, under `authorize`, call `fibrepulse` after the module that loads the password (`files` or `sql`):

```
authorize {
    ...
    sql
    fibrepulse
    if (notfound) {
        ok   # not a FibrePulse customer: keep the ISP's own decision
    }
    ...
}
```

On the MikroTik router: `/ppp aaa set use-radius=yes accounting=yes`, plus `/radius add service=ppp address=<FreeRADIUS IP> secret=<radius secret>`. Optionally add `/radius incoming set accept=yes`, so FreeRADIUS CoA can also be used later.

Health check: `curl http://10.0.0.5:18120/health` returns the number of customers in the list and when it was last updated.

**For the engineer:** test with one customer before switching the pilot over: renew, let the package expire, then suspend and restore. Accounting (session start and stop) still goes to the ISP's RADIUS. FibrePulse reads sessions from the router API, not from RADIUS accounting.

## Hotspot (Phase 8)

Hotspot users buy a code for one device. The router's hotspot asks RADIUS, and RADIUS asks the connector, as for PPPoE, but the connector itself answers for codes:

- The rlm_rest body must also send the device MAC: `data = "{\"username\": \"%{User-Name}\", \"mac\": \"%{Calling-Station-Id}\"}"`.
- For a valid code the connector returns `200` with `control:Cleartext-Password` (the code, so FreeRADIUS can check PAP or CHAP without a password file), `reply:Session-Timeout` (seconds left; the router cuts the user off at zero) and `reply:Mikrotik-Rate-Limit`. A code used on another device, or with no time left, gets `401` with a message. The first login is remembered on disk, so time keeps counting even if the link to FibrePulse is down.
- In `sites-enabled/default`, call `fibrepulse` for hotspot requests even when no other module found the user (the code is not in `sql` or `files`).
- On the router: `/ip hotspot profile set [find] use-radius=yes login-by=http-chap,http-pap`, and `/radius add service=hotspot address=<FreeRADIUS IP> secret=<radius secret>`.
- Login page: replace the hotspot `login.html` with a redirect to `https://<FibrePulse>/wifi/<isp>?link-login-only=$(link-login-only)&mac=$(mac)`. The FibrePulse page posts the code back to the router's login address (only private addresses are accepted).
- Walled garden: allow the FibrePulse host and Safaricom's M-Pesa hosts so people can pay before they are online: `/ip hotspot walled-garden add dst-host=<FibrePulse host>`.
- When a code is cancelled or its time ends while the user is online, FibrePulse queues `disconnect_hotspot`; the connector removes the user's `/ip hotspot active` entry and cookie (needs `ALLOW_ROUTER_WRITES=true`).

## Internet from Safaricom

Every poll the connector asks the router to ping the check address (`POST /rest/ping`, 3 packets; default 8.8.8.8, set in Settings › Organisation). Two failed checks in a row mark the line down, raise the alert "Internet from Safaricom is down at …" and show a red banner on every screen with the provider's support phone. Latency and loss are kept as metrics. If the connector stops reporting for 3 minutes, the banner says the site cannot be reached instead, because FibrePulse cannot tell. For the demo, `SIMULATE_UPSTREAM_DOWN=true npm run connector:demo` simulates an outage.

## Not measured

Wi-Fi quality and optical (ONU/ONT) power need CPE (TR-069) or OLT telemetry. The NOC says "not measured" instead of showing numbers.

## Local demo

`npm run db:seed` registers a "Demo simulator" connector for the two simulated routers and writes its token to `connector/mikrotik-agent/.env` (git-ignored). With the app running, `npm run connector:demo` (add `-- --once` for one cycle) reports SIMULATED readings. Simulated data is accepted only for routers marked simulated, is labelled everywhere, and is excluded from availability figures.
