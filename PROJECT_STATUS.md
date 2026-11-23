# FibrePulse project status

_Last updated: 23 November 2026 (end of Phase 1)._

Legend: **Done and tested** · **Simulated** (works, uses labelled test data) · **Not built** (planned phase in brackets).

## Decisions so far

- Build the full application here first, then hand the code to a software engineer for production and live M-Pesa.
- First customer: one pilot ISP moving off a provider that charges 3%. Multi-tenant structure kept from day one.
- Platform fee: **2.75% of gross verified subscription collections** (pilot default, configurable per ISP agreement).
- **No cash** payment method for the pilot. Methods: M-Pesa, bank transfer, other.
- Pilot ISP packages, prices and size: not provided yet, so fictional data is used.

## Phase 1: Product foundation

| Area | Status | Evidence |
|---|---|---|
| Project setup (Next.js 16, TS strict, Tailwind 4, shadcn-style UI, ESLint) | Done and tested | `npm run build`, `typecheck`, `lint` clean |
| Database: 30 tables, enums, composite tenant foreign keys, money as numeric | Done and tested | `supabase/migrations/*0100–0500*` |
| Row Level Security on every table, permission matrix in SQL | Done and tested | `tests/db/tenant-isolation.test.ts` (every tenant table, read/update/delete/insert) |
| Supabase Auth: sign up, sign in, sign out, password reset, email link callback | Done and tested | `tests/e2e/phase1.spec.ts` |
| ISP registration (pending until FibrePulse activates), draft 2.75% gross agreement | Done and tested | `tests/db/onboarding-and-guards.test.ts`, e2e |
| Staff invitations, role changes, enable/disable, last-owner and self-change guards | Done and tested | DB tests + e2e |
| Five ISP roles + two platform roles, server-side permission checks | Done and tested | `tests/db/role-permissions.test.ts`, `tests/unit/permissions.test.ts` |
| Platform staff see no ISP data without an owner-approved, time-boxed (≤72h) support grant | Done and tested | DB tests |
| Audit log (append-only) on sensitive tables, with reasons | Done and tested | DB tests |
| Payment guards: duplicate references, immutable amounts, simulated never verified, manual entries start unverified | Done and tested (schema level) | DB tests. Screens in Phase 2 |
| Commercial agreement guards: frozen once signed, no overlapping periods, one fee record per period | Done and tested (schema level) | DB tests. Fee engine in Phase 6 |
| App shell: NOC dark theme, responsive sidebar and phone menu, role-filtered navigation | Done and tested | e2e desktop + phone |
| Overview page with real counts only | Done | Executive dashboard charts in Phase 3 |
| Platform admin: tenant list, activate/suspend/deactivate with audited reason | Done and tested | DB tests + e2e |
| Demo seed data (2 fictional ISPs, 8 users) | Simulated | Routers flagged `data_source = simulated` and badged in the UI |

Test totals at end of Phase 1: **142 database tests, 33 unit tests, 9 browser tests, all passing.**

## Not built yet

| Module | Phase |
|---|---|
| Customer, package, subscription screens; manual payments, invoices, allocation; CSV import/export | 2 |
| Executive dashboard charts, revenue analytics, reconciliation, CSV/PDF reports | 3 |
| MikroTik connector agent, ingest API, router monitoring, alerts, NOC screen | 4 |
| Support desk, field operations, notifications delivery (email/SMS), Leaflet map, BI reports | 5 |
| Fee engine, platform invoices, agreements UI, platform revenue analytics, support-access UI | 6 |
| Live Safaricom Daraja / M-Pesa | Software engineer (see docs/MPESA_INTEGRATION_HANDOVER.md) |

## Known limitations

- Invitation emails are not sent yet; the owner tells the person to sign up with the invited email.
- Notifications are in-app only.
- No hosted Supabase project yet; everything runs locally.
