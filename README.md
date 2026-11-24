# FibrePulse

**See your network. Understand your revenue. Grow your ISP.**

FibrePulse is a multi-tenant ISP operations and business intelligence platform for Kenyan fibre internet providers: customers, subscriptions, M-Pesa and bank collections, MikroTik network monitoring, support and field operations in one secure workspace.

> Status: **Phases 1 to 7 complete** (foundation, billing, financial analytics, network monitoring, business operations, the FibrePulse commercial platform, testing and handover). What is left for the software engineer is listed in [docs/DEVELOPER_HANDOVER.md](docs/DEVELOPER_HANDOVER.md). See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what is built, tested, simulated and not yet built.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui components · Supabase (Postgres 17, Auth, Row Level Security) · Zod · Vitest · Playwright. Recharts and Leaflet arrive with the analytics and map phases.

## Quick start (local)

Requirements: Node 20+ (22 recommended), Docker (for local Supabase).

```bash
npm install
cp .env.example .env.local          # then fill in the two Supabase values below
npm run db:start                    # starts local Supabase in Docker
npx supabase status                 # copy API URL and Publishable key into .env.local
npm run db:reset                    # applies supabase/migrations
npm run db:seed                     # fictional demo ISPs and users
npm run dev                         # http://localhost:3000
```

Demo sign-ins (local only, password `FibrePulse-Demo-2026`):

| Email | Role |
|---|---|
| owner@mwangaza.test | ISP Owner, Mwangaza Fibre Networks (active) |
| finance@mwangaza.test | Finance Manager |
| network@mwangaza.test | Network Administrator |
| support@mwangaza.test | Customer Support Agent |
| tech@mwangaza.test | Field Technician |
| owner@pwani.test | ISP Owner, Pwani Connect (pending activation) |
| admin@fibrepulse.test | FibrePulse Super Administrator |
| support@fibrepulse.test | FibrePulse Support Administrator |

All demo people, numbers and places are fictional. Demo routers are marked **Simulated**.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run test:unit` | Unit tests (no database needed) |
| `npm run test:db` | Database tests: RLS, tenant isolation, roles, money guards (needs local Supabase) |
| `npm run test:e2e` | Browser tests (needs the app running and demo data seeded) |
| `npm run db:reset` | Recreate the local database from migrations |
| `npm run db:seed` | Load fictional demo data (refuses non-local databases) |

## Repository layout

```
src/app/(auth)            sign in, sign up, password reset
src/app/(isp-dashboard)   ISP screens (Overview, Customers, … Settings)
src/app/(platform-admin)  FibrePulse admin area (/admin)
src/app/onboarding        register an ISP or accept an invitation
src/components            ui/ (shadcn-style), layout/, shared/
src/modules               business logic per domain (tenants, platform, auth)
src/lib                   supabase clients, auth/permissions, validation, security
supabase/migrations       documented SQL migrations (schema, RLS, functions)
tests/unit|db|e2e         Vitest unit + database tests, Playwright browser tests
scripts/seed-demo.ts      fictional demo data
docs/                     architecture, schema, security, handover
```

## Documentation

- [Project overview](docs/PROJECT_OVERVIEW.md) · [Product requirements](docs/PRODUCT_REQUIREMENTS.md)
- [System architecture](docs/SYSTEM_ARCHITECTURE.md) · [Database schema](docs/DATABASE_SCHEMA.md) · [API](docs/API_DOCUMENTATION.md)
- [Security guide](docs/SECURITY_GUIDE.md) · [Testing guide](docs/TESTING_GUIDE.md) · [Deployment guide](docs/DEPLOYMENT_GUIDE.md)
- [MikroTik integration](docs/MIKROTIK_INTEGRATION.md) · [M-Pesa handover](docs/MPESA_INTEGRATION_HANDOVER.md) · [Developer handover](docs/DEVELOPER_HANDOVER.md)
