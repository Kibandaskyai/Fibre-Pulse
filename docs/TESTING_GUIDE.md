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
