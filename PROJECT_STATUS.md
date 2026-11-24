# FibrePulse project status

_Last updated: 24 November 2026 (end of Phase 7: build complete, ready for the software engineer)._

Legend: **Done and tested** · **Simulated** (works, uses labelled test data) · **Not built** (planned phase in brackets).

## Decisions so far

- Build the full application here first, then hand the code to a software engineer for production and live M-Pesa.
- First customer: one pilot ISP moving off a provider that charges 3%. Multi-tenant structure kept from day one.
- Platform fee: **2.75% of gross verified subscription collections** (pilot default, configurable per ISP agreement).
- **No cash** payment method for the pilot. Methods: M-Pesa, bank transfer, other.
- Pilot ISP packages (monthly, provided 23 Nov 2026): Micro 5 Mbps Ksh 1,000 · Lite 10 Mbps Ksh 1,500 · Starter 20 Mbps Ksh 2,000 · Plus 30 Mbps Ksh 2,500 · Family 40 Mbps Ksh 3,000. Used in the demo seed. Upload speed assumed equal to download until confirmed. Pilot size not provided yet.
- Answers of 24 Nov 2026: a package that **ends without renewal disconnects** the customer (like suspension); the pilot ISP uses **RADIUS**; SMS goes through **Safaricom**; platform invoices go out **automatically** each month.

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
| Network, support and BI reports | Done in Phase 5 | see below |

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

## Phase 5: Business operations

| Area | Status | Evidence |
|---|---|---|
| Support desk (`/support`): tickets with category, priority, customer, assignment to active staff, comments, resolution notes required to resolve or close, full history; counts and filters; links from the customer profile | Done and tested | `tests/db/operations.test.ts`, e2e `phase5.spec.ts` |
| Field operations (`/field-operations`): jobs from a ticket or customer, technician and visit time, technician "My jobs" view, start, notes, completion needs work notes and closes the job to the technician; job history on the ticket | Done and tested | DB and e2e |
| Notifications: inbox with unread filter and mark-read, per-person and ISP-wide preferences per type and channel, de-duplication. Sent for new and assigned tickets and jobs, completed jobs, verified/rejected/reversed payments (never simulated), packages ending within 3 days, router outages (2+ real routers offline) | Done and tested | DB tests (16), e2e |
| Email and SMS copies queued in `notification_outbox` | Queued, not delivered | needs a provider (software engineer TODO) |
| Network map (`/network-map`, Leaflet): routers with coverage circles, outages, open jobs; exact customer points only for roles with `customers:view_location`, everyone else sees area totals | Done and tested | e2e (owner vs support agent) |
| Business intelligence reports (`/reports/bi/…`), each with date range, area filter where it applies, CSV and PDF: customer acquisition and churn, subscription performance, payment reconciliation, network availability and router performance, support and field operations (with technician performance), geographical performance | Done and tested | DB tests (permissions and figures), unit (CSV, PDF), e2e downloads |
| Demo data: 3 tickets, 1 job, approximate map points for demo customers, router coverage | Simulated | `npm run db:seed` |

Test totals at end of Phase 5: **319 unit, database and connector tests and 46 browser tests, all passing.**

### Report definitions

- Churn: customers whose last package ended in the month (expired or cancelled) with no renewal since, divided by customers with a live package on the first day of that month.
- Network availability: share of connector polls in which the router answered. Simulated routers are listed but left out of the headline figure; routers with no readings show "No readings".
- Ticket and job times run from opening to resolution or completion; "within 24 h" is the share closed inside a day.
- Geographical area is the customer's estate, else town, else county. Routers count in every area whose customers they serve.

### Open questions for the pilot ISP (Phase 5)

- Target response and resolution times for tickets (reports use 24 hours for now).
- Which email and SMS provider to use for notifications (e.g. Africa's Talking for SMS).
- Map tiles: OpenStreetMap's public tiles are fine for a pilot; production should use a commercial tile provider.

## Phase 6: FibrePulse commercial platform

| Area | Status | Evidence |
|---|---|---|
| Commercial agreements (`/admin/agreements`, ISP page): versioned drafts, sign (frozen), end; one draft at a time; start on the 1st of a month; a new version supersedes the old one from its start month and cannot reach back into calculated months | Done and tested | `tests/db/platform-billing.test.ts`, e2e `phase6.spec.ts` |
| Fee engine: per ISP per calendar month (Kenyan time), on verified, successful, non-simulated payments in charged categories; gross or less 16% VAT; recalculation adds adjustments (never edits a month); "calculate for every ISP" run | Done and tested | DB tests (Oct 2026 figures, late-night edge, reversal adjustment) |
| Platform invoices (`/admin/invoices`): collect uninvoiced fees, number `FP-YYYY-NNNNN`, VAT % per invoice (0 for now), due date, overdue shown after due date, record payment by reference, void with reason (fees freed for a new invoice); amounts frozen | Done and tested | DB and e2e |
| ISP side: `/settings/billing` for owner and finance (agreement terms, monthly fees, invoices, balance); notification when an invoice is issued | Done and tested | e2e (finance sees it, network admin is refused) |
| Platform overview (`/admin`): ISPs, eligible collections, fees earned, uninvoiced, unpaid and overdue, month so far, paid, signed agreements, subscriber counts; fees by month and onboarding charts; revenue per ISP | Done and tested | DB tests (permissions), screenshots |
| Support access: platform staff request with a reason, the ISP owner approves (1 to 72 hours), declines or revokes at `/settings/support-access`; read-only network view only while active; all audited | Done and tested | DB and e2e |
| Audit log (`/admin/audit`): agreement, fee, invoice, ISP and support-access changes in plain words | Done and tested | e2e |
| Role limits: support administrators see ISP counts and their own support requests only; fees, agreements, invoices and the audit log are for super administrators | Done and tested | DB and e2e |
| Demo data: Mwangaza's agreement signed at 2.75% from October 2026. No fees or invoices are seeded because demo payments are simulated | Simulated | `npm run db:seed` |

Test totals at end of Phase 6: **79 unit tests, 256 database tests and 55 browser tests, all passing**, plus lint, typecheck and production build.

### Fee rules

- Fee = rate × eligible collections for the calendar month in Kenyan time. Eligible means successful, verified, not simulated, and in a category the agreement charges (internet subscriptions always; installation, equipment and other are left out by default).
- A month is calculated only after it ends and only under a signed agreement covering it.
- Signed terms and calculated fees never change. A late verification or a reversal becomes an adjustment line on the next invoice. A negative balance waits until it is covered by later fees.
- Invoices are issued without VAT until FibrePulse is VAT registered.

### Open questions (Phase 6)

- Is FibrePulse VAT registered, and from when? (Invoices default to 0% VAT.)
- FibrePulse's legal name, KRA PIN, address and paybill/bank details for the invoice.
- Should invoices be issued automatically each month, or stay a manual step? Should a PDF be emailed?

## Phase 7: Testing, automation and handover

| Area | Status | Evidence |
|---|---|---|
| Expired packages disconnect (same three switches as suspension); renewing reconnects; early replacement never disconnects | Done and tested | `tests/db/automation.test.ts` |
| Scheduled expiry for every ISP every 5 minutes (`pg_cron`), not only when a screen loads | Done and tested | DB test (schedule installed, job runs) |
| RADIUS access control: owner setting; the connector serves "who may connect, at what speed" to FreeRADIUS (`rlm_rest`) from FibrePulse data, cached on disk; disconnect drops the live session only; passwords stay in the ISP's RADIUS | Done and tested (FreeRADIUS config to confirm on site) | `tests/connector/radius.test.ts`, DB and e2e tests |
| Automatic monthly platform billing on the 1st at 06:00 EAT: fees for every ISP, invoices for each ISP with fees waiting; every run recorded and shown on *Platform Invoices* | Done and tested | DB tests (manual run, scheduled run, permissions), e2e |
| SMS delivery worker (`npm run worker:sms`): claims SMS copies from the outbox, Kenyan number format, one 160-character SMS, retries, never marks unsent messages as sent; Safaricom provider with token handling | Built; Safaricom request body waits for the contract | `tests/unit/sms.test.ts`, DB tests |
| Security sweep driven by the database catalogue: no ISP sees another ISP's rows in any table; outsiders see nothing; platform staff see no ISP customer, payment or network rows without a grant; RLS on every table; the public can write nothing and call only the connector functions; every SECURITY DEFINER function pins `search_path` | Done and tested | `tests/db/security-sweep.test.ts` |
| Deployment guide, engineer handover list, RADIUS guide | Done | docs/DEPLOYMENT_GUIDE.md, docs/DEVELOPER_HANDOVER.md, docs/MIKROTIK_INTEGRATION.md |

Test totals at end of Phase 7: **91 unit and connector tests, 276 database tests and 58 browser tests, all passing**, plus lint, typecheck and production build.

## Not built yet

| Module | Phase |
|---|---|
| Safaricom SMS request/response (worker and outbox done) and email delivery | Software engineer |
| Invoice PDF, FibrePulse legal and tax details on invoices, paying platform invoices by M-Pesa | Software engineer |
| Live Safaricom Daraja / M-Pesa | Software engineer (see docs/MPESA_INTEGRATION_HANDOVER.md) |

## Known limitations

- Invitation emails are not sent yet; the owner tells the person to sign up with the invited email.
- Notifications are delivered in-app only until the Safaricom SMS contract is wired in and an email provider is chosen; copies wait in `notification_outbox`.
- Cancelling a package does not disconnect (not decided). Hotspot users are not disconnected.
- No hosted Supabase project yet; everything runs locally.
