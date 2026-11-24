# Security guide

## What is in place (Phase 1)

| Control | Where |
|---|---|
| Supabase Auth, passwords hashed by Supabase, 10+ characters with mixed case and a digit | `src/lib/validation/auth.ts` |
| Session in httpOnly cookies, JWT validated with `getClaims()` on the server | `src/proxy.ts`, `src/lib/auth/session.ts` |
| RLS on all 30 tables; anon role has no table access | migration 0003; test "every public table has row level security enabled" |
| Composite tenant foreign keys | migration 0002 |
| Server-side permission checks before every action | `src/lib/auth/guards.ts` |
| Zod validation on every form | `src/lib/validation` |
| Open-redirect protection on `next` | `src/lib/security/redirect.ts` (unit tested) |
| Generic login error (no account enumeration); generic password-reset reply | `src/modules/auth/actions.ts` |
| Append-only audit log with actor and reason | migration 0001, triggers on sensitive tables |
| Platform staff isolation; support grants owner-approved, ≤72 hours, audited | migrations 0001/0003 |
| Router credentials write-only (no SELECT policy) | migration 0003 |
| Users cannot grant themselves platform roles or change tenant status | guard triggers |
| No secrets in client code; `.env*` ignored by git except `.env.example` | `.gitignore` |
| `server-only` on modules that must never reach the browser | `src/lib/supabase/server.ts`, `src/lib/auth/*` |

## Network connector (Phase 4)

| Control | Where |
|---|---|
| Connector token `fpc_` + 40 random characters, shown once, stored as SHA-256; revocable | `src/modules/network/service.ts`, `connector_agents` |
| Every request HMAC-signed over time, nonce, method, path and body hash; 5-minute window; nonces single use; 120 requests a minute | `private.authenticate_connector` |
| Connector routes run with the publishable key; no service-role key in the app | `src/app/api/connector/v1/*` |
| Router passwords AES-256-GCM encrypted in the app server with `ROUTER_CREDENTIALS_KEY`, write-only to users, decrypted only to answer an authenticated connector; or kept only on the connector machine | `src/lib/connector/credentials.ts` |
| Simulated readings refused for real routers and vice versa | `connector_ingest` |
| Router writes need the owner's toggle, `ALLOW_ROUTER_WRITES=true` on the connector and the router user's write policy; only PPPoE disable/enable is possible | migration `20261126000100`, `connector/mikrotik-agent/src/commands.ts` |
| Telemetry updates do not flood the audit log; configuration changes, credentials, commands and alert handling are audited | audit triggers |
| Retention: metrics 90 days, closed sessions 365 days, nonces 1 hour | `network_watchdog` |

## Production checklist (for the engineer)

- [ ] Enable email confirmation in Supabase Auth (local config has it off for development).
- [ ] Set Auth rate limits and enable CAPTCHA on sign-up.
- [ ] Enable MFA (TOTP) and require it for ISP owners and platform admins.
- [ ] Set `site_url` and allowed redirect URLs to the production domain only.
- [ ] Add security headers (CSP, HSTS, frame-ancestors) in `next.config.ts`.
- [ ] Add rate limiting on the payment callback endpoint (the connector API already limits each connector to 120 requests a minute in the database).
- [ ] Router credential encryption key in a secret manager (`ROUTER_CREDENTIALS_KEY`), with rotation via `key_version`.
- [ ] Daily backups and point-in-time recovery on Supabase Pro; test a restore.
- [ ] Error monitoring (e.g. Sentry) with PII scrubbing.
- [ ] Platform super admins are set only by an operator in SQL (`update profiles set platform_role = 'super_admin' ...`).

## Kenya Data Protection Act, 2019

- FibrePulse is a **data processor** for each ISP (the controller). Sign a data processing agreement with the pilot ISP before importing real customer data.
- Check whether the ISP and FibrePulse must register with the Office of the Data Protection Commissioner (ODPC).
- Data minimisation: exact GPS is in a separate table with narrower access; platform staff do not see personal data by default.
- Retention and deletion (to implement in Phase 5/7): terminated customers anonymised after an agreed period; raw network metrics kept ~30 days, rollups longer; audit logs kept for at least the financial record retention period (7 years under Kenyan tax law; confirm with the ISP's accountant).
- Breach handling: ODPC notification within 72 hours of becoming aware; keep an incident runbook.
- Development uses fictional data only.

## Phase 5 notes

- Exact customer locations are only sent to the browser for roles with `customers:view_location` (owner and network administrator). Other roles get area totals; the map says so.
- Notification links are same-site paths only (`safeNextPath`), so a crafted notification cannot redirect off the site.
- Ticket and job history cannot be written or edited by users; only the triggers write it.
- BI report functions return aggregates only and check the report permission inside the database, as well as in the page and export route.
- Email and SMS copies are queued with the recipient's profile only; the delivery worker (not built) must look up contact details server-side with the service role and must respect the person's preferences already applied at insert time.

## Phase 6 notes

- Platform staff have no standing access to ISP customer, payment or network rows. A support administrator asks with a reason; only the ISP owner (`staff:manage`) can approve, for 1 to 72 hours, and can revoke at any time. Access is read-only, limited to the person who asked, and every request and decision is in the audit log.
- Platform analytics functions return totals and counts only; the overview never lists ISP customers.
- Support administrators cannot see fees, agreements, invoices or the audit log (database functions and pages both check).
- Commercial records cannot be written through the API at all except via the audited `admin_*` functions. Signed terms, fee records and invoice amounts are frozen by triggers, including for the database owner role, so a historical rate can never change silently.
- Simulated and unverified payments can never become fee revenue.
