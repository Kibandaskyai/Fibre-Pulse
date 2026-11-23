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

## Production checklist (for the engineer)

- [ ] Enable email confirmation in Supabase Auth (local config has it off for development).
- [ ] Set Auth rate limits and enable CAPTCHA on sign-up.
- [ ] Enable MFA (TOTP) and require it for ISP owners and platform admins.
- [ ] Set `site_url` and allowed redirect URLs to the production domain only.
- [ ] Add security headers (CSP, HSTS, frame-ancestors) in `next.config.ts`.
- [ ] Add rate limiting on the connector ingest and payment callback endpoints.
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
