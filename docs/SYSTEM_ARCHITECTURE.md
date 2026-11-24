# System architecture

## Components

| Component | Runs where | Responsibility | Status |
|---|---|---|---|
| Web app (Next.js App Router) | Vercel (planned) | UI, Server Actions, Route Handlers, Zod validation, permission checks | Phase 1 built |
| Supabase Postgres | Supabase | All data, RLS on every table, SQL guard functions | Phase 1 built |
| Supabase Auth | Supabase | Email/password, sessions in httpOnly cookies | Phase 1 built |
| Background worker (Node) | Managed host | Subscription expiry, alert evaluation, metric rollups, monthly fees, notifications | Phase 3–6 |
| Connector Agent (Node) | Inside each ISP's network | Polls MikroTik routers (RouterOS 7 REST), signed outbound HTTPS to `/api/connector/v1/*`; PPPoE disable/enable only when the owner and the connector both allow it | Phase 4 built |
| Payment provider layer | Web app + worker | `PaymentProvider` interface, manual provider, Daraja stub | Phase 2 (stub), engineer (live) |

```
Browser ──HTTPS──▶ Next.js (Server Actions, user JWT) ──▶ Supabase Postgres (RLS)
                         ▲                                   ▲
Connector Agent ─signed HTTPS (outbound only)─┘              │
MikroTik routers ◀─read-only REST (inside ISP network)       │
Background worker ───────────────────────────────────────────┘
Safaricom Daraja ─callbacks (future)─▶ /api/payments/mpesa/callback
```

The cloud never opens a connection into an ISP network.

## Request path and authorisation (three layers)

1. **Proxy** (`src/proxy.ts`): refreshes the Supabase session cookie; signed-out visitors go to `/login`. `getClaims()` validates the JWT.
2. **Server guard** (`src/lib/auth/guards.ts`): pages call `requireTenant()` / `requirePagePermission()`; actions call `assertPermission()`. Builds friendly errors and hides navigation.
3. **Postgres RLS** (migration 0003): final authority. Every query from the app uses the user's JWT, never the service role.

The service role key is reserved for two future server-only paths: the connector ingest endpoint and the payment callback endpoint. No Phase 1 code uses it (the seed script uses it locally only).

## Tenancy model

- Shared database and schema; `tenant_id` on every tenant-owned row.
- Composite foreign keys `(tenant_id, parent_id)` make cross-tenant references impossible.
- Helper functions in schema `private`: `tenant_role_of`, `is_member`, `has_permission`, `is_platform_admin`, `is_platform_staff`, `has_support_grant`, `my_technician_id`, `is_assigned_technician`.
- Members of `suspended` or `deactivated` ISPs lose all access; `pending` ISPs can be set up.
- The active ISP for a user with several memberships is stored in the `fp_tenant` httpOnly cookie and always re-validated against their memberships.

## Simulated vs real data

`data_source` (`simulated`, `manual`, `connector`, `provider`) on payments, routers, interfaces, sessions, metrics and alerts. The `DataSourceBadge` component labels figures. A database constraint prevents simulated payments from ever being verified, so they can never count as revenue or feed platform fees.

## Code organisation

- `src/modules/<domain>/service.ts`: business logic taking a Supabase client (testable, RLS-respecting).
- `src/modules/<domain>/actions.ts`: Server Actions: validate with Zod, check permission, call the service, revalidate.
- `src/lib/validation`: Zod schemas and Kenyan helpers (phone normalisation, counties).
- `src/components/ui`: shadcn-style primitives (hand-written because the shadcn registry was unreachable from the build environment; `components.json` is present so `npx shadcn add` works normally).
