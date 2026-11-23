# API documentation

The app uses Next.js Server Actions (form posts) and Supabase PostgREST/RPC under the user's JWT. The only public endpoint is the M-Pesa callback placeholder.

## Route handlers

| Route | Method | Purpose |
|---|---|---|
| `/auth/callback` | GET | Completes Supabase email links (`code` or `token_hash` + `type`). `next` is restricted to same-site paths by `safeNextPath`. |
| `/customers/export` | GET | CSV of customers with the screen's filters. `customers:view`; balances only with `invoices:view`. |
| `/payments/export` | GET | CSV of payments with the screen's filters, including a `counts_as_revenue` column. `payments:view`. |
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

## Planned endpoints

| Route | Phase | Notes |
|---|---|---|
| `POST /api/connector/ingest` | 4 | Connector token + HMAC signature, rate limited, replay protected |
