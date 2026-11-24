# FibrePulse project status

_Last updated: 23 November 2026 (end of Phase 4)._

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

## Phase 3: Financial intelligence

| Area | Status | Evidence |
|---|---|---|
| Revenue functions in the database: KPIs, daily/monthly series, breakdown by package/area/method, outstanding ageing, package mix, customer growth, area list. Kenyan dates, area filter, `revenue:view` checked in SQL | Done and tested | `tests/db/revenue.test.ts` (15) |
| Executive dashboard (`/overview`): date range and area filters; customers, verified collections, service and network KPIs; collections, 12-month trend, methods, areas, growth, package mix; recent payments, customers and alerts. Network uptime and online/offline now come from the connector (Phase 4) | Done and tested | e2e, screenshots |
| Revenue analytics (`/revenue`): collected vs previous period, applied vs credit, invoiced, awaiting verification, outstanding and overdue, reversals and refunds, packages sold, simulated exclusions; charts; package/area/method; cash shown as "not accepted"; outstanding by age and the 20 largest balances | Done and tested | e2e `phase3.spec.ts` |
| Statement reconciliation (`/payments/reconcile`): upload an M-Pesa paybill or bank CSV, auto-detect layout and columns, preview, then verify exact matches (reference and amount) in one audited step; lists amount mismatches, simulated hits, statement money not in FibrePulse (kept for follow-up) and recorded payments missing from the statement | Done and tested | `tests/db/reconciliation.test.ts` (9), unit parser tests, e2e |
| Daily collections and monthly revenue reports (`/reports`) on screen, plus CSV and PDF downloads of these and of any revenue page filter | Done and tested | unit, e2e (file names, contents, `%PDF`) |
| Network, support and BI reports | Not built (5) | `/reports` says so; no figures shown |

Test totals at end of Phase 3: **248 unit and database tests and 29 browser tests, all passing.**

### Reporting rules

- Collected revenue = payments that are successful **and** verified against a statement. Awaiting verification, failed, reversed, refunded and simulated payments are shown separately and never added in.
- "Applied to invoices" is what has been allocated to invoices issued in the period's payments; the rest is credit (overpayment or unlinked deposit).
- Days and months are Kenyan calendar days; a payment at 01:30 on the 3rd counts on the 3rd even though it is the 2nd in UTC.
- Area matches a customer's county, town or estate.
- Reconciliation only verifies a payment when the reference, method and amount all match and the payment is successful, unverified and not simulated. Re-uploading the same statement changes nothing.

## Phase 4: Network monitoring and the MikroTik connector

| Area | Status | Evidence |
|---|---|---|
| Connector agent for MikroTik RouterOS 7 REST (`connector/mikrotik-agent/`): polling, rates, sessions, buffering and backoff, simulator, Docker and systemd packaging | Done and tested | `tests/connector/agent.test.ts` (13) |
| Signed connector API (`/api/connector/v1/sync`, `ingest`, `commands`): token hash, HMAC, replay and rate limits, no service role | Done and tested | `tests/db/network.test.ts` (20) |
| Routers, encrypted API credentials, connector registration (token shown once) | Done and tested | e2e `phase4.spec.ts` |
| NOC (`/network`): routers online, sessions, paying customers online, alerts, router table, download and upload traffic; router pages with CPU, memory, sessions, interfaces, connected customers | Done and tested | e2e, screenshots |
| Alerts (`/alerts`): router offline, high CPU/memory, connector offline, failed disconnects; de-duplicated, auto-clearing, acknowledge/resolve with notes, in-app notifications | Done and tested | DB and e2e |
| Suspend disconnects on the router, restore reconnects: owner toggle plus connector `ALLOW_ROUTER_WRITES`; results and retry on the customer profile | Done and tested | DB and e2e; agent tests for the RouterOS calls |
| Overview: online/offline customers and 24-hour router availability (real routers only) | Done | screenshots |
| Wi-Fi and optical signal | Not measured | needs CPE or OLT telemetry; the NOC says so |

Test totals at end of Phase 4: **283 unit, database and connector tests and 36 browser tests, all passing.**

### Open questions for the pilot ISP

- Should expiry or cancellation also disconnect on the router? (Today only suspension does.)
- Do they use RADIUS? If so, disconnect has to happen in RADIUS, not on the router.
- Hotspot customers are monitored but not disconnected.
- RouterOS versions (7.1+ needed) and the computer that will run the connector.

## Not built yet

| Module | Phase |
|---|---|
| Support desk, field operations, notifications delivery (email/SMS), Leaflet map, BI reports | 5 |
| Fee engine, platform invoices, agreements UI, platform revenue analytics, support-access UI | 6 |
| Live Safaricom Daraja / M-Pesa | Software engineer (see docs/MPESA_INTEGRATION_HANDOVER.md) |

## Known limitations

- Invitation emails are not sent yet; the owner tells the person to sign up with the invited email.
- Notifications are in-app only.
- No hosted Supabase project yet; everything runs locally.
