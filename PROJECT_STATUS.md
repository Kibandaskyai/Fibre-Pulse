# FibrePulse project status

_Last updated: 23 November 2026 (end of Phase 2)._

Legend: **Done and tested** · **Simulated** (works, uses labelled test data) · **Not built** (planned phase in brackets).

## Decisions so far

- Build the full application here first, then hand the code to a software engineer for production and live M-Pesa.
- First customer: one pilot ISP moving off a provider that charges 3%. Multi-tenant structure kept from day one.
- Platform fee: **2.75% of gross verified subscription collections** (pilot default, configurable per ISP agreement).
- **No cash** payment method for the pilot. Methods: M-Pesa, bank transfer, other.
- Pilot ISP packages (monthly, provided 23 Nov 2026): Micro 5 Mbps Ksh 1,000 · Lite 10 Mbps Ksh 1,500 · Starter 20 Mbps Ksh 2,000 · Plus 30 Mbps Ksh 2,500 · Family 40 Mbps Ksh 3,000. Used in the demo seed. Upload speed assumed equal to download until confirmed. Pilot size not provided yet.

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

## Phase 2: ISP business operations

| Area | Status | Evidence |
|---|---|---|
| Packages: create, edit, stop selling, archive; price changes never alter existing subscriptions | Done and tested | e2e `phase2.spec.ts` |
| Customers: list, search (name, number, phone in any Kenyan format, PPPoE), status/area/balance filters, profile with history tabs, add, edit, GPS for permitted roles | Done and tested | e2e, unit |
| Customer CSV import with a check step and duplicate report (existing phone/PPPoE, repeats in file, invalid rows) | Done and tested | unit `billing.test.ts`, e2e |
| CSV export of customers and payments, formula-injection safe | Done and tested | unit, e2e |
| Subscriptions: activate, renew (stacks after current expiry), upgrade, downgrade, suspend/restore/cancel with audited reasons, automatic expiry | Done and tested | `tests/db/billing.test.ts`, e2e |
| Invoices issued automatically on every purchase; one-off charges; void with reason | Done and tested | DB tests |
| Manual payments (M-Pesa / bank / other, no cash), verification against a statement, rejection, reversal, auto-allocation oldest-first, manual allocation, linking unmatched deposits | Done and tested | DB tests, e2e |
| Money and subscription state change only through audited database functions (direct table writes refused) | Done and tested | DB tests |
| M-Pesa provider interface, Daraja stub and 501 placeholder routes | Placeholder | `src/lib/integrations/payments/provider.ts` |
| Demo data: subscriptions bought through the real functions; two SIMULATED payments that can never be verified | Simulated | `npm run db:seed` |

Test totals at end of Phase 2: **212 unit and database tests and 23 browser tests, all passing.**

### Billing rules (confirmed with the user on 23 Nov 2026 unless marked)

- Confirmed: upgrades and downgrades start the new package immediately for a full period, with **no credit** for unused days.
- Renewing the same package adds the new period after the current expiry, so no paid days are lost.
- Monthly packages run for one calendar month (31 Jan to 28/29 Feb), in Kenyan time.
- Confirmed: suspending **must disconnect the customer on the router**, and restoring reconnects them. This is built in Phase 4 with the MikroTik connector (disable the PPPoE secret and drop the active session, then re-enable on restore). Until then the screen tells staff to disconnect on the router themselves.
- Confirmed: only the ISP owner can sell packages and suspend; finance records, verifies and reverses payments.

## Not built yet

| Module | Phase |
|---|---|
| Executive dashboard charts, revenue analytics, reconciliation, CSV/PDF reports | 3 |
| MikroTik connector agent, ingest API, router monitoring, alerts, NOC screen | 4 |
| Support desk, field operations, notifications delivery (email/SMS), Leaflet map, BI reports | 5 |
| Fee engine, platform invoices, agreements UI, platform revenue analytics, support-access UI | 6 |
| Live Safaricom Daraja / M-Pesa | Software engineer (see docs/MPESA_INTEGRATION_HANDOVER.md) |

## Known limitations

- Invitation emails are not sent yet; the owner tells the person to sign up with the invited email.
- Notifications are in-app only.
- No hosted Supabase project yet; everything runs locally.
