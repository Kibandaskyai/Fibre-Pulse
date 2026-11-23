# API documentation

Phase 1 uses Next.js Server Actions (form posts) and Supabase PostgREST/RPC under the user's JWT. There are no public REST endpoints yet.

## Route handlers

| Route | Method | Purpose |
|---|---|---|
| `/auth/callback` | GET | Completes Supabase email links (`code` or `token_hash` + `type`). `next` is restricted to same-site paths by `safeNextPath`. |

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

## Planned endpoints

| Route | Phase | Notes |
|---|---|---|
| `POST /api/connector/ingest` | 4 | Connector token + HMAC signature, rate limited, replay protected |
| `POST /api/payments/mpesa/stk-push` | Engineer | TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION |
| `POST /api/payments/mpesa/callback` | Engineer | Idempotent on CheckoutRequestID and MpesaReceiptNumber |
