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
