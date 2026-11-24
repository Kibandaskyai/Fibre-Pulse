# API documentation

The app uses Next.js Server Actions (form posts) and Supabase PostgREST/RPC under the user's JWT. Public endpoints are the connector API (token and signature checked inside the database) and the M-Pesa callback placeholder.

## Route handlers

| Route | Method | Purpose |
|---|---|---|
| `/auth/callback` | GET | Completes Supabase email links (`code` or `token_hash` + `type`). `next` is restricted to same-site paths by `safeNextPath`. |
| `/customers/export` | GET | CSV of customers with the screen's filters. `customers:view`; balances only with `invoices:view`. |
| `/payments/export` | GET | CSV of payments with the screen's filters, including a `counts_as_revenue` column. `payments:view`. |
| `/reports/export` | GET | Financial report as CSV or PDF (`format=csv\|pdf`). `kind=range` (with the revenue page's `range`, `from`, `to`, `area`; needs `revenue:view`), `kind=daily&date=YYYY-MM-DD` or `kind=monthly&month=YYYY-MM` (need `reports:financial` too). Built by `src/modules/analytics/report.ts` and `report-pdf.ts`. |
| `/api/connector/v1/sync` | POST | Connector agent: router list (with decrypted API credentials), queued commands, poll interval. |
| `/api/connector/v1/ingest` | POST | Connector agent: readings for up to 200 routers (body ≤ 2 MB). Returns `{accepted, rejected[]}`. |
| `/api/connector/v1/commands` | POST | Connector agent: `{command, success, message}` result of a disconnect/reconnect. |
| `/api/payments/mpesa/stk-push` | POST | 501 placeholder. TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION |
| `/api/payments/mpesa/callback` | POST | 501 placeholder, public path (Safaricom calls it). Must authenticate before trusting anything. |

## Server actions

| Action | Module | Permission |
|---|---|---|
| `signInAction`, `signUpAction`, `signOutAction`, `forgotPasswordAction`, `resetPasswordAction` | `src/modules/auth/actions.ts` | none / signed in |
| `registerTenantAction` | `src/modules/tenants/actions.ts` | signed in |
| `acceptInvitationAction` | tenants | invited email, confirmed |
| `switchTenantAction` | tenants | member of the target ISP |
| `inviteStaffAction`, `revokeInvitationAction`, `changeRoleAction`, `setMemberStatusAction` | tenants | `staff:manage` |
| `updateOrganisationAction` | tenants | `settings:manage` |
| `setTenantStatusAction` | `src/modules/platform/actions.ts` | platform super admin |
| `createPackageAction`, `updatePackageAction`, `setPackageStatusAction` | `src/modules/packages/actions.ts` | `packages:edit` |
| `createCustomerAction`, `updateCustomerAction`, `importCustomersAction` | `src/modules/customers/actions.ts` | `customers:edit` (GPS also needs `customers:view_location`) |
| `purchaseSubscriptionAction` | `src/modules/billing/actions.ts` | `subscriptions:edit` |
| `changeSubscriptionAction` (suspend / restore / cancel) | billing | `subscriptions:suspend`; cancel needs `subscriptions:edit` |
| `createInvoiceAction`, `voidInvoiceAction` | billing | `invoices:edit` |
| `recordPaymentAction` | billing | `payments:record` |
| `verifyPaymentAction`, `rejectPaymentAction`, `reversePaymentAction`, `allocatePaymentAction`, `assignPaymentCustomerAction` | billing | `payments:reconcile` |
| `reconcileStatementAction` (step `check` then `apply`) | `src/modules/reconciliation/actions.ts` | `payments:reconcile` |

Every action validates input with Zod and returns `ActionResult` (`{ ok, message, fieldErrors? }`).

## Database functions (RPC)

| Function | Caller | Notes |
|---|---|---|
| `register_tenant(name, slug, county, town, contact_phone, owner_name)` | signed-in user | Creates pending tenant, owner membership, draft v1 agreement (2.75% gross). Max 3 owned ISPs per person. |
| `accept_invitation(invitation_id)` | invited user | Email must match and be confirmed. Technicians also get a `technicians` row. |
| `my_permissions(tenant_id)` | member | Permission strings for the caller's role. |
| `my_invitations()` | signed-in user | Open invitations for the caller's email with ISP name. |
| `admin_list_tenants()` | platform staff | Tenant list with owner contact and staff count only. |
| `admin_set_tenant_status(tenant, status, reason)` | super admin | Reason is written to the audit log. |
| `purchase_subscription(customer, package)` | `subscriptions:edit` | New / renewal (stacks after current expiry) / upgrade / downgrade (starts now, no proration). Issues an invoice and applies credit. |
| `suspend_subscription`, `restore_subscription`, `cancel_subscription` | see actions | Reason ≥ 5 characters (restore optional). No router command is sent. |
| `expire_due_subscriptions(tenant)` | member or service role | Idempotent; called on page load now, by the worker later. |
| `create_invoice(customer, lines jsonb, due_date, notes)`, `void_invoice(invoice, reason)` | `invoices:edit` | Void refused once payments are allocated. |
| `verify_payment(payment, statement_source, statement_reference, notes)` | `payments:reconcile` | Not for simulated payments. Records reconciliation and auto-allocates oldest invoice first. |
| `reject_payment`, `reverse_payment(payment, reason)` | `payments:reconcile` | Reversal keeps the row, removes allocations, reopens invoices. |
| `allocate_payment(payment, invoice, amount)`, `assign_payment_customer(payment, customer)` | `payments:reconcile` | Same-ISP only; amounts capped by the guard trigger. |

| `revenue_kpis(tenant, from, to, area)` | `revenue:view` | jsonb of collected (by method), recognised, credit, awaiting verification, simulated excluded, reversed, refunded, outstanding, overdue, invoiced, package sales, today/week/month. Dates are Kenyan. |
| `revenue_series(tenant, from, to, grain day\|month, area)` | `revenue:view` | Gaps filled with zero. |
| `revenue_breakdown(tenant, from, to, dimension package\|area\|method, area)` | `revenue:view` | Package view follows allocations to invoices and subscriptions. |
| `outstanding_ageing(tenant, area)` | `revenue:view` | Not yet due, 1–30, 31–60, 61–90, over 90 days. |
| `subscription_distribution(tenant, area)`, `customer_growth(tenant, months, area)`, `customer_areas(tenant)` | `subscriptions:view` / `customers:view` | For dashboard charts and the area filter. |
| `reconcile_statement(tenant, source, lines jsonb, apply)` | `payments:reconcile` | `source` is `mpesa_statement` or `bank_statement`; lines are `{line, reference, amount, date, details}` (max 5,000). Preview when `apply` is false; otherwise verifies exact matches, allocates them and records unknown lines as `unmatched`. |

## FibrePulse commercial platform (Phase 6)

Agreements, fee records and platform invoices have no insert or update policies: every write goes through these SECURITY DEFINER functions, which check the caller and write the audit reason. `admin_*` functions need a **super administrator** unless noted.

| Function | Notes |
|---|---|
| `admin_save_agreement(tenant, agreement\|null, fee_rate, fee_basis gross\|net_of_vat, excluded revenue_category[], effective_from, notes)` | Creates or edits the one draft. Rate > 0 and ≤ 20%; subscriptions cannot be excluded; start must be the 1st of a month and after every signed version. Returns the draft id. |
| `admin_discard_agreement(agreement)` | Drafts only. |
| `admin_sign_agreement(agreement, signed_by)` | Freezes the draft, supersedes the version in force from the new start month. Refused if fees from that month are already calculated. |
| `admin_end_agreement(agreement, end_month, reason)` | No fees from `end_month`. |
| `admin_calculate_fees(tenant, month)` | Returns `result` (`calculated`, `unchanged`, `adjustment`), the record, and the month's totals. Finished months under a signed agreement only. |
| `admin_calculate_all_fees(month)` | One row per active ISP: result `calculated`, `unchanged`, `adjustment`, `no_agreement` or `error`. |
| `admin_issue_platform_invoice(tenant, due_days 1–90, tax_rate 0–0.5, notes)` | Puts every calculated, uninvoiced record on a new `FP-YYYY-NNNNN` invoice; refused when the total is 0 or less. Notifies holders of `platform_billing:view`. |
| `admin_record_platform_payment(invoice, reference, paid_on)` | Marks an issued invoice paid. |
| `admin_void_platform_invoice(invoice, reason)` | Keeps the invoice, frees its records for a new invoice. |
| `admin_platform_summary()`, `admin_platform_monthly(months)`, `admin_isp_revenue()` | Platform analytics (counts and money only, no ISP customer rows). |
| `request_support_access(tenant, reason)` | Any platform staff member. One open request per person per ISP. Notifies holders of `staff:manage`. |
| `decide_support_access(grant, approve\|decline\|revoke, hours 1–72)` | ISP `staff:manage` (the owner). |
| `admin_support_grants()` | Super admins see all requests, support admins their own; `mine` marks the caller's. |

ISP staff with `platform_billing:view` (owner, finance) read their own agreements, fee records and non-draft invoices directly through RLS.

### Routes

| Route | Who |
|---|---|
| `/admin`, `/admin/agreements`, `/admin/invoices`, `/admin/invoices/{id}`, `/admin/audit`, `/admin/tenants/{id}` (billing parts) | Super administrator |
| `/admin/support-access`, `/admin/tenants/{id}` (support card, network under an active grant) | Any platform staff |
| `/settings/billing`, `/settings/billing/invoices/{id}` | `platform_billing:view` |
| `/settings/support-access` | `staff:manage` |

## Planned endpoints

| Route | Phase | Notes |
|---|---|---|

## Connector API (Phase 4)

Every request carries `Authorization: Bearer fpc_…` plus three headers:

| Header | Value |
|---|---|
| `x-fibrepulse-timestamp` | ISO time; must be within 5 minutes of the server |
| `x-fibrepulse-nonce` | random, single use (replays are refused) |
| `x-fibrepulse-signature` | hex HMAC-SHA256, keyed by the token, of `timestamp\nnonce\nMETHOD\npath\nsha256(body)` |

Errors: 401 bad token/signature/replay, 429 over 120 requests a minute per connector, 400 invalid payload, 404 unknown command. Signing code: `src/lib/connector/signature.ts` (identical copy in the agent). The routes use the publishable key with no session; `connector_sync`, `connector_ingest` and `connector_command_result` authenticate the token themselves. No service-role key is used.

Ingest reading shape: `{router_id, collected_at, reachable, skipped?, error?, system?: {identity, model, serial_number, version, uptime_seconds, cpu_load_pct, memory_used_pct}, interfaces?: [{name, type, mac_address, running, disabled, rx_bps, tx_bps}], sessions?: [{type: pppoe|hotspot, username, address, caller_id, uptime_seconds}]}`, with `simulated: true` on the batch for simulator data.

### Network functions for staff

| Function | Permission | Notes |
|---|---|---|
| `set_router_credentials(router, username, ciphertext, key_version)` | `network:credentials` | Ciphertext is AES-256-GCM `v1:iv:tag:ct`, encrypted in the app server. |
| `router_credential_status(tenant)` | `network:view` | Which routers have credentials and the username; never the password. |
| `assign_customer_router(customer, router)` | `network:edit` | |
| `set_router_enforcement(tenant, enabled)` | `settings:manage` (owner) | Turns router disconnect on/off. |
| `retry_router_command(command)` | `subscriptions:suspend` | Failed, blocked or expired commands only. |
| `update_alert(alert, acknowledge\|resolve, note)` | `alerts:manage` | |
| `network_watchdog(tenant)` | member | Stale connectors, unanswered commands, retention. At most once a minute. |
| `network_traffic(tenant, hours, router)`, `router_history(router, hours)`, `network_availability(tenant, hours)` | `network:view` (RLS) | Charts and uptime. |

## Business operations (Phase 5)

Tickets and jobs are written directly through RLS (`tickets:edit`, `jobs:edit`, or `jobs:update_own` for the assigned technician). Triggers enforce the rules and write the history, so the app and any future API behave the same.

| Function | Permission | Notes |
|---|---|---|
| `add_ticket_comment(ticket, note)` | `tickets:edit` or the assignee | Adds a `comment` event. |
| `add_job_note(job, note)` | `jobs:edit` or the assigned technician | |
| `technician_directory(tenant)` | `jobs:view` or `tickets:edit` | Active technicians with open job counts. |
| `staff_directory(tenant)` | member | Names and roles for assignment lists. |
| `notify_expiring_subscriptions(tenant)` | member | Packages ending within 3 days; once per period. Called with expiry on page load (worker later). |
| `router_report(tenant, from, to)` | `reports:network` | Availability, polls, CPU/memory avg and max, peak sessions, offline alerts and warnings per router. Max 400 days. |
| `bi_customer_report(tenant, from, to, area)` | `reports:financial` + `customers:view` | Monthly new customers, first connections, live at start, lapsed, disconnected, churn %. |
| `bi_subscription_report(tenant, from, to, area)` | `reports:financial` | Per package: live, suspended, new, renewals, upgrades, downgrades, restores, lapsed, sales value. |
| `bi_payment_report(tenant, from, to)` | `reports:financial` | Payments by method and status (matched, verified only, awaiting, rejected, failed, reversed), with unallocated money. |
| `bi_support_report(tenant, from, to)` | `reports:support` | Rows of kind `ticket` (by category), `job` (by type) and `technician`: opened, resolved, open now, average and median hours, % within 24 h. |
| `bi_area_report(tenant, from, to)` | `reports:financial` + `revenue:view` | Per area: customers, new, live packages, collected, outstanding, tickets, open tickets, routers and offline routers. |

The BI functions are SECURITY DEFINER aggregates: they check the permission and tenant themselves and never return individual rows. Simulated customers and payments are left out.

### Routes

| Route | Notes |
|---|---|
| `GET /reports/bi/{customers\|subscriptions\|payments\|network\|support\|areas}/export?range=&from=&to=&area=&format=csv\|pdf` | Same permission as the report page; 403 otherwise. |
| `GET /notifications/open/{id}` | Marks the notification read and redirects to its link (same-site paths only). |

