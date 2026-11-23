# Developer handover

Start with [PROJECT_STATUS.md](../PROJECT_STATUS.md), then [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) and [SECURITY_GUIDE.md](SECURITY_GUIDE.md).

## Mental model

- The database is the security boundary. Read migration 0003 before changing any table.
- Adding a permission: add it to `PERMISSIONS` and `ROLE_PERMISSIONS` in `src/lib/auth/permissions.ts` **and** to `private.role_permissions` in a new migration. `tests/db/onboarding-and-guards.test.ts` › permission matrix fails until both match.
- Adding a tenant table: include `tenant_id`, `unique (tenant_id, id)`, composite FKs, enable RLS, write policies using `private.has_permission`, and add it to `TENANT_TABLES` in `tests/helpers/fixtures.ts` so isolation is tested automatically.
- Business logic goes in `src/modules/<domain>/service.ts` taking a Supabase client; Server Actions stay thin.

## Searching for unfinished work

```bash
grep -rn "TODO: SOFTWARE ENGINEER" .
grep -rn "TODO(Phase" src
```

## Environment notes

- Next.js 16 uses `src/proxy.ts` (formerly `middleware.ts`).
- Supabase uses the new publishable/secret keys; the code also accepts `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Fonts are system fonts (no build-time font download).
