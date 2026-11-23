# Database schema

Migrations live in `supabase/migrations` and are applied in order by `supabase db reset` / `supabase db push`.

| Migration | Contents |
|---|---|
| `20261123000100_foundation.sql` | Extensions, core enums, `private` schema, `updated_at` trigger, tenants, profiles (auto-created from `auth.users`), tenant_members, tenant_invitations, support_access_grants, audit_logs + generic audit trigger, tenant_counters |
| `20261123000200_business_tables.sql` | Customers (+ customer_locations), packages, subscriptions, invoices, invoice_lines, payments, payment_allocations, payment_reconciliation_records, connector_agents, routers, router_credentials, router_interfaces, network_sessions, network_metrics, network_alerts, technicians, support_tickets, installation_jobs, notifications, commercial_agreements, platform_invoices, platform_fee_records; guard triggers; audit triggers |
| `20261123000300_permissions_and_rls.sql` | Role→permission matrix, RLS helper functions, guards (tenant status, platform role, last owner, technician edits, notifications), RLS enabled and policies on every table, anon revoked |
| `20261123000400_tenant_functions.sql` | `register_tenant`, `accept_invitation`, `my_permissions`, `my_invitations` |
| `20261123000500_platform_functions.sql` | `admin_list_tenants`, `admin_set_tenant_status` |
| `20261124000100_billing_functions.sql` | Phase 2: period maths in EAT, subscription purchase/renewal/upgrade/downgrade, suspend/restore/cancel/expire, invoices, payment verify/reject/reverse/allocate/assign, `customer_account_summary` and `customer_directory` views. Removes direct browser writes to payments (update), allocations, reconciliation records, invoices, invoice lines and subscriptions: these change only through the functions. |

| `20261125000100_revenue_analytics.sql` | Phase 3: `revenue_kpis`, `revenue_series`, `revenue_breakdown`, `outstanding_ageing`, `subscription_distribution`, `customer_growth`, `customer_areas` (SECURITY INVOKER, so RLS applies; `revenue:view` checked first), helpers `private.require_revenue_view`, `private.in_area` |
| `20261125000200_statement_reconciliation.sql` | Phase 3: `reconcile_statement` (SECURITY DEFINER, `payments:reconcile`). Writes `payment_reconciliation_records` rows: `matched` for verified payments, `unmatched` with no payment for statement money nobody recorded (linked later when the payment is recorded and reconciled) |

## Conventions

- `id uuid` primary keys (`gen_random_uuid()`); `bigint identity` for audit_logs and network_metrics.
- Money: `numeric(14,2)` (amounts), `numeric(12,2)` (prices), fee rate `numeric(6,4)` (0.0275 = 2.75%). Never float.
- Currency `char(3)` default `KES`. Timestamps `timestamptz` (UTC). Business dates in Africa/Nairobi.
- Phone numbers stored as E.164 `+2547XXXXXXXX` / `+2541XXXXXXXX`.
- Every tenant table: `tenant_id not null`, `unique (tenant_id, id)`, children reference `(tenant_id, parent_id)`.

## Tables by domain

The 23 tables required by the spec, plus additions marked (+).

**Identity and tenancy:** tenants, profiles, tenant_members, tenant_invitations (+), support_access_grants (+), audit_logs, tenant_counters (+).

**Customers:** customers (customer_number unique per ISP, phone unique per ISP among non-terminated customers, PPPoE username unique per ISP), customer_locations (+, exact GPS bounded to Kenya, stricter permission).

**Packages and subscriptions:** service_packages (billing period with duration rule: daily=1, weekly=7, monthly=calendar month, custom=required), subscriptions (price and period copied at purchase; one live subscription per customer).

**Billing and payments:** invoices (total = subtotal + tax, amount_paid ≤ total), invoice_lines (+, category drives fee eligibility), payments, payment_allocations (+, cannot exceed payment amount or invoice total), payment_reconciliation_records.

**Network:** connector_agents (token stored as SHA-256 hash), routers (+ `api_scheme`, `verify_tls`, `consecutive_failures`), router_credentials (+, encrypted, no SELECT policy at all), router_interfaces, network_sessions, network_metrics, network_alerts (+ `dedupe_key`: one open alert per problem), router_commands (+, Phase 4: disconnect/reconnect queue with status `queued → sent → succeeded/failed`, or `blocked`, `cancelled`, `expired`; read-only to users). `customers.router_id` (+) is learned from sessions. Private: `connector_nonces` (replay protection, 1 hour), `watchdog_runs`. Retention: metrics 90 days, closed sessions 365 days.

**Operations:** technicians, support_tickets, installation_jobs, notifications.

**Commercial:** commercial_agreements (versioned; terms frozen after signing; no overlapping in-force periods), platform_fee_records (one per tenant per period; fee = round(eligible × rate, 2); corrections are adjustment rows), platform_invoices.

## Guards that protect money

| Rule | Enforced by |
|---|---|
| Duplicate transaction reference | unique index `(tenant_id, method, provider_reference)` |
| Amount, method, reference, date, source immutable | trigger `guard_payment_immutable` |
| Simulated payments never verified | check `payments_simulated_never_verified` |
| People can only record manual, unverified payments | RLS insert policy |
| Allocations ≤ payment and ≤ invoice | constraint trigger `guard_allocation_totals` |
| Signed agreement terms frozen | trigger `guard_agreement_terms` |
| No overlapping in-force agreements | exclusion constraint (btree_gist) |
| A period charged once | partial unique index on platform_fee_records |
| Invoice paid only by verified, successful payments | `private.recompute_invoice` |
| Verification, reversal and allocation are checked, audited, single transactions | Phase 2 SECURITY DEFINER functions; no direct write policies |

## Relationships (main)

tenants 1─* tenant_members *─1 profiles · tenants 1─* customers 1─1 customer_locations · customers 1─* subscriptions *─1 service_packages · customers 1─* invoices 1─* invoice_lines · payments *─* invoices via payment_allocations · payments 1─* payment_reconciliation_records · connector_agents 1─* routers 1─* router_interfaces / network_sessions / network_metrics / network_alerts · routers 1─1 router_credentials · customers 1─* support_tickets 1─* installation_jobs *─1 technicians · tenants 1─* commercial_agreements 1─* platform_fee_records *─1 platform_invoices.
