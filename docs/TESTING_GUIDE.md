# Testing guide

| Suite | Command | Needs | Count (Phase 1) |
|---|---|---|---|
| Unit | `npm run test:unit` | nothing | 33 |
| Database | `npm run test:db` | local Supabase (`npm run db:start && npm run db:reset`) | 142 |
| Browser (Playwright) | `npm run test:e2e` | local Supabase, `npm run db:seed`, app on :3000 (`npm run build && npm run start`) | 9 (8 desktop, 1 phone) |

## How database tests work

`tests/helpers/db.ts` connects to the local Postgres as `postgres`, builds fixtures (`tests/helpers/fixtures.ts`: two fictional ISPs with one row in every tenant table and a user for every role), then runs each check inside a transaction that does `set local role authenticated` with a JWT claim for a specific user, exactly like a real API request. Transactions are rolled back.

Coverage mapped to spec Part 12:

| Spec test | Where |
|---|---|
| 1 Authentication | e2e: sign-in, wrong password, redirect when signed out, sign-up |
| 2 Tenant registration | `onboarding-and-guards.test.ts` › tenant registration; e2e |
| 3 Tenant isolation | `tenant-isolation.test.ts` (read, update, delete, insert, FK, anon, suspended ISP, RLS on every table) |
| 4 Role-based permissions | `role-permissions.test.ts`, `permissions.test.ts`, e2e |
| 8 Payment recording (schema guards) | `onboarding-and-guards.test.ts` › payment guards |
| 9 Duplicate transaction detection | same |
| 11 Platform fee calculations (schema guards) | same › commercial agreement guards |
| 15 API validation | `validation.test.ts` |
| Unauthorised access | across all three DB suites and e2e |

Tests 5–7, 10, 12–14 belong to Phases 2–6 and will be added with those modules.

## Proving the tests have teeth

During Phase 1, RLS on `payments` was disabled temporarily; 8 tests failed immediately, then passed again once RLS was restored.

## Phase 2 additions

- `tests/db/billing.test.ts` (26): period end dates in EAT (month-end clamping, leap years, late-evening purchases), new/renewal/upgrade/downgrade, refusals (archived package, terminated customer, wrong role, other ISP), suspend/restore/cancel/expiry, verification and auto-allocation, part payment and credit, simulated payments, duplicate receipts, rejection, reversal, unmatched deposits, manual allocation limits, no direct writes.
- `tests/unit/billing.test.ts`: CSV parser, import duplicate report, CSV formula escaping, package/customer/payment validation, time zone helpers, search sanitising.
- `tests/e2e/phase2.spec.ts` (14): sell a package, invoice, record → verify → paid, duplicate reference, finance cannot sell, reversal, suspend/restore, phone search, CSV import, exports, role blocks, 501 placeholder, phone layout.
- The browser tests create uniquely named data each run, so re-running needs no reset. `npm run db:seed` after a reset adds demo subscriptions through the real functions.

## Phase 3 additions

- `tests/db/revenue.test.ts` (15): exact KPI figures from known payments, Kenyan dates across midnight UTC, area filter, today/week/month windows, ageing buckets, series gaps, breakdowns, permissions (support and network roles refused) and ISP isolation.
- `tests/db/reconciliation.test.ts` (9): preview classifies every line without changing anything; exact matches verified and allocated (invoice paid); amount mismatches, simulated, already verified, repeated and unreadable lines left alone; unknown lines recorded once and linked when the payment is recorded later; payments missing from the statement; bank vs M-Pesa references; audit entry; permission, isolation and size limits.
- `tests/unit/analytics.test.ts`: date range presets in Kenyan time, custom ranges, statement amount/date parsing, M-Pesa and bank statement layouts, report helpers and PDF text safety.
- `tests/e2e/phase3.spec.ts` (6): record two payments, check and apply a statement upload, revenue and daily report show only the verified one, CSV/PDF downloads, support agent blocked, dashboard and revenue fit a phone screen.

## Phase 4 additions

- `tests/db/network.test.ts` (20): connector token, signature window, replay and revoke; rate limit; ingest of health, interfaces and sessions (linked to customers); router offline after two failures with notifications; CPU alerts; simulated data only for simulated routers; time window; router disconnect off/on; suspend → disconnect → restore → reconnect; cancel of an unsent disconnect; blocked commands and retry; failure alerts and watchdog re-send; owner-only toggle; connector-offline alert; alert permissions; credentials unreadable; ISP isolation.
- `tests/connector/agent.test.ts` (13): the real agent against a fake RouterOS server and a fake FibrePulse that checks signatures with the app's own code: config rules (HTTPS, token format), reading and rates, sessions only when reads succeed, unreachable routers, writes refused unless allowed, disconnect/reconnect calls, simulator, buffering while FibrePulse is down.
- `tests/e2e/phase4.spec.ts` (7): register a connector (token shown once), run the agent in SIMULATE mode and see readings and sessions, add a real router with an invalid then valid IP, save encrypted credentials (never shown back), run the agent against an unreachable router and see it go offline, acknowledge and resolve the critical alert, role blocks, the owner's disconnect toggle with suspend/restore, phone layout. Needs `ROUTER_CREDENTIALS_KEY` in `.env.local` and `npm run db:seed` after a reset (the suspend test uses demo customer `sim-kasarani-cor-02`).
