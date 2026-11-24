# Developer handover

Start with [PROJECT_STATUS.md](../PROJECT_STATUS.md), then [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) and [SECURITY_GUIDE.md](SECURITY_GUIDE.md).

## Mental model

- The database is the security boundary. Read migration 0003 before changing any table.
- Adding a permission: add it to `PERMISSIONS` and `ROLE_PERMISSIONS` in `src/lib/auth/permissions.ts` **and** to `private.role_permissions` in a new migration. `tests/db/onboarding-and-guards.test.ts` › permission matrix fails until both match.
- Adding a tenant table: include `tenant_id`, `unique (tenant_id, id)`, composite FKs, enable RLS, write policies using `private.has_permission`, and add it to `TENANT_TABLES` in `tests/helpers/fixtures.ts` so isolation is tested automatically.
- Business logic goes in `src/modules/<domain>/service.ts` taking a Supabase client; Server Actions stay thin.
- Hotspot (Phase 8) lives in migration `20261130000100_hotspot.sql`, `src/modules/hotspot/`, `src/app/(isp-dashboard)/hotspot/` and the public page `src/app/wifi/[slug]/`. A code is a `hotspot_vouchers` row; the RADIUS list sent to the connector includes running and unused codes. Automatic vouchers are not audited row by row (thousands a day); staff sales, free codes and cancellations are.
- Anything that moves money or changes a subscription's state is a SECURITY DEFINER function in migration `20261124000100`, which checks the permission itself and sets the audit reason. There are deliberately no direct write policies for those tables; add a function, not a policy.
- Forms use `useFormAction` from `src/components/shared/form-bits.tsx`, which keeps typed values after a validation error (React's default form action resets the form).

## What is left for you (as of 24 Nov 2026)

Everything else in the spec is built and tested (see PROJECT_STATUS.md). These items need accounts, contracts or decisions that only the business can provide:

| # | Work | Where to start | Blocked on |
|---|---|---|---|
| 1 | **Live M-Pesa (Daraja):** STK push, the C2B/STK callback, and automatic verification of callback payments | `src/lib/integrations/payments/provider.ts`, `src/app/api/payments/mpesa/*`, docs/MPESA_INTEGRATION_HANDOVER.md | Daraja production app, shortcode, passkey |
| 2 | **Safaricom SMS:** the request and response in `buildRequest()` / `parseResponse()` | `src/lib/sms/safaricom.ts` (the worker, retries, outbox, phone format and tests are done) | Safaricom Bulk SMS contract and sender ID |
| 3 | **Email delivery** for notifications and staff invitations | Same outbox (`channel = 'email'`); `src/modules/tenants/actions.ts` | Choice of email provider |
| 4 | **Hosting:** Supabase project, Vercel, SMS worker host, connector machine at the ISP | docs/DEPLOYMENT_GUIDE.md | Accounts and domain |
| 5 | **RADIUS go-live:** confirm the FreeRADIUS `rest` config against the ISP's version and test one customer | docs/MIKROTIK_INTEGRATION.md › RADIUS | Access to the ISP's RADIUS server |
| 6 | **Invoice details:** FibrePulse legal name and paybill; PDF download and email of platform invoices (no VAT or KRA for now) | `src/components/platform/invoice-document.tsx` | Company registration details |
| 7 | **Map tiles:** a commercial tile provider for production | `src/components/map/network-map.tsx` | Provider choice |
| 8 | **MFA** for platform administrators (Supabase Auth MFA) | auth pages | none |
| 9 | **Hotspot M-Pesa:** STK push from the WiFi page and the paybill C2B confirmation, calling `set_hotspot_checkout`, `confirm_hotspot_payment` and `record_paybill_hotspot_payment` | `src/modules/hotspot/portal-actions.ts`, docs/MPESA_INTEGRATION_HANDOVER.md › Hotspot | Daraja production app |
| 10 | **Hotspot on the router:** login page redirect to `/wifi/<isp>`, walled garden, RADIUS for hotspot | docs/MIKROTIK_INTEGRATION.md › Hotspot | Access to the ISP's router and RADIUS |

The old comment in migration `20261127000100` mentions Africa's Talking for SMS. That comment is superseded: the pilot chose **Safaricom**. Do not edit applied migrations; this note is the correction.

## Background jobs

| Job | Runs | Where |
|---|---|---|
| Expire packages and hotspot codes whose time ended (queues disconnects); unpaid WiFi-page prompts fail after 10 minutes | every minute | `pg_cron` `fibrepulse-expire-subscriptions` → `private.scheduled_expiry()` |
| Monthly platform billing: calculate last month for every ISP, issue invoices (due in 14 days) | 1st of the month, 03:00 UTC (06:00 EAT) | `pg_cron` `fibrepulse-monthly-billing` → `admin_run_monthly_billing`; each run is recorded in `platform_billing_runs` |
| Connector watchdog (offline routers/connectors, re-sending commands) | on every connector call and page load | migration `20261126000100` |
| SMS delivery | every 30 seconds | `npm run worker:sms` (separate process, service role) |

Scheduled database jobs run with no signed-in user. They mark themselves with the transaction setting `fibrepulse.system_job`, which `private.is_system_job()` honours only when the session user is the database owner. API callers connect as `authenticator`, so they can never use it.

## Searching for unfinished work

```bash
grep -rn "TODO: SOFTWARE ENGINEER" .
grep -rn "TODO(Phase" src
```

## Environment notes

- Next.js 16 uses `src/proxy.ts` (formerly `middleware.ts`).
- Supabase uses the new publishable/secret keys; the code also accepts `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Fonts are system fonts (no build-time font download).
