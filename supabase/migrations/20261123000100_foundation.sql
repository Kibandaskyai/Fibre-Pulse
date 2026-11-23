-- =============================================================================
-- FibrePulse migration 0001: foundation
--
-- Extensions, enum types, the `private` helper schema, shared trigger
-- functions, and the identity/tenancy tables:
--   tenants, profiles, tenant_members, tenant_invitations,
--   support_access_grants, audit_logs, tenant_counters
--
-- Conventions used across all FibrePulse migrations:
--   * Every tenant-owned table has `tenant_id uuid not null` and a
--     `unique (tenant_id, id)` key so children can use composite foreign
--     keys (tenant_id, parent_id). This makes it impossible, at the database
--     level, for a row in tenant A to reference a row in tenant B.
--   * Money is numeric(14,2). Never float.
--   * Timestamps are timestamptz (UTC); business periods are computed in the
--     tenant timezone (default Africa/Nairobi).
--   * RLS is enabled in migration 0003 for every table created here.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- Helper functions used by RLS live in a schema that PostgREST does not expose.
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enum types
-- -----------------------------------------------------------------------------
create type public.tenant_status as enum ('pending', 'active', 'suspended', 'deactivated');
create type public.tenant_role as enum ('owner', 'finance', 'network_admin', 'support_agent', 'technician');
create type public.member_status as enum ('active', 'disabled');
create type public.platform_role as enum ('super_admin', 'support_admin');

-- Where a row of operational data came from. `simulated` rows are never
-- treated as verified revenue or live network state.
create type public.data_source as enum ('simulated', 'manual', 'connector', 'provider');

-- -----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- -----------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- tenants: one row per ISP business
-- -----------------------------------------------------------------------------
create table public.tenants (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (char_length(name) between 2 and 120),
  slug                   text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  legal_name             text,
  contact_email          extensions.citext,
  contact_phone          text check (contact_phone is null or contact_phone ~ '^\+254[0-9]{9}$'),
  county                 text,
  town                   text,
  timezone               text not null default 'Africa/Nairobi',
  currency               char(3) not null default 'KES',
  customer_number_prefix text not null default 'FP' check (customer_number_prefix ~ '^[A-Z]{2,5}$'),
  status                 public.tenant_status not null default 'pending',
  activated_at           timestamptz,
  deactivated_at         timestamptz,
  settings               jsonb not null default '{}'::jsonb,
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table public.tenants is 'ISP businesses using FibrePulse. Status is controlled by platform super admins only.';

create trigger tenants_updated_at before update on public.tenants
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- profiles: one row per auth user (created by trigger on auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  full_name     text not null default '' check (char_length(full_name) <= 120),
  phone         text check (phone is null or phone ~ '^\+254[0-9]{9}$'),
  email         extensions.citext,
  -- Null for ISP staff. Only set directly in the database by an operator;
  -- never through the application (guarded by trigger below).
  platform_role public.platform_role,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on column public.profiles.platform_role is 'FibrePulse staff role. Platform staff get no ISP data access from this alone.';

create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

-- Create a profile automatically for every new auth user.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(left(new.raw_user_meta_data ->> 'full_name', 120), ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Keep profiles.email in sync when a user changes their email.
create or replace function private.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function private.handle_user_email_change();

-- -----------------------------------------------------------------------------
-- tenant_members: which users belong to which ISP, with which role
-- -----------------------------------------------------------------------------
create table public.tenant_members (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  profile_id         uuid not null references public.profiles (id) on delete cascade,
  role               public.tenant_role not null,
  status             public.member_status not null default 'active',
  notification_prefs jsonb not null default '{}'::jsonb,
  invited_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, profile_id),
  unique (tenant_id, id)
);
create index tenant_members_profile_idx on public.tenant_members (profile_id) where status = 'active';

create trigger tenant_members_updated_at before update on public.tenant_members
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- tenant_invitations: owner invites staff by email; the invited person signs
-- up (or in) with that verified email and accepts. No service-role key needed.
-- -----------------------------------------------------------------------------
create table public.tenant_invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  email       extensions.citext not null,
  role        public.tenant_role not null check (role <> 'owner'), -- ownership is never granted by invitation
  invited_by  uuid not null references public.profiles (id) on delete cascade,
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index tenant_invitations_open_unique
  on public.tenant_invitations (tenant_id, email)
  where accepted_at is null and revoked_at is null;
create index tenant_invitations_email_idx on public.tenant_invitations (email)
  where accepted_at is null and revoked_at is null;

-- -----------------------------------------------------------------------------
-- support_access_grants: time-boxed, owner-approved access for FibrePulse
-- support staff. Without a live grant, platform staff see no ISP data.
-- -----------------------------------------------------------------------------
create table public.support_access_grants (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  granted_to       uuid not null references public.profiles (id) on delete cascade,
  requested_reason text not null check (char_length(requested_reason) between 10 and 500),
  approved_by      uuid references public.profiles (id) on delete set null,
  approved_at      timestamptz,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  check (approved_at is null or (approved_by is not null and expires_at is not null and expires_at > approved_at)),
  check (expires_at is null or approved_at is null or expires_at <= approved_at + interval '72 hours')
);
create index support_access_grants_lookup on public.support_access_grants (granted_to, tenant_id);

-- -----------------------------------------------------------------------------
-- audit_logs: append-only record of sensitive changes.
-- tenant_id is null for platform-level events.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references public.tenants (id) on delete set null,
  actor_id    uuid,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  before_data jsonb,
  after_data  jsonb,
  reason      text,
  created_at  timestamptz not null default now()
);
create index audit_logs_tenant_idx on public.audit_logs (tenant_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

-- Generic audit trigger. Attach to any table whose changes must be traceable.
-- A reason can be supplied for the current transaction with:
--   select set_config('fibrepulse.audit_reason', 'text', true);
create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_id     uuid;
  v_before jsonb;
  v_after  jsonb;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after  := to_jsonb(new);
    if v_before = v_after then
      return new;
    end if;
  else
    v_after := to_jsonb(new);
  end if;

  v_tenant := coalesce(v_after, v_before) ->> 'tenant_id';
  v_id     := coalesce(v_after, v_before) ->> 'id';
  if tg_table_name = 'tenants' then
    v_tenant := v_id;
  end if;

  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (
    v_tenant,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_id,
    v_before,
    v_after,
    nullif(current_setting('fibrepulse.audit_reason', true), '')
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger tenants_audit after insert or update or delete on public.tenants
  for each row execute function private.audit_row_change();
create trigger tenant_members_audit after insert or update or delete on public.tenant_members
  for each row execute function private.audit_row_change();
create trigger tenant_invitations_audit after insert or update or delete on public.tenant_invitations
  for each row execute function private.audit_row_change();
create trigger support_access_grants_audit after insert or update or delete on public.support_access_grants
  for each row execute function private.audit_row_change();

-- -----------------------------------------------------------------------------
-- tenant_counters: gap-tolerant per-tenant document numbers
-- (customer numbers, invoice numbers, ticket numbers, job numbers).
-- -----------------------------------------------------------------------------
create table public.tenant_counters (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (name in ('customer', 'invoice', 'ticket', 'job', 'receipt')),
  next_value bigint not null default 1 check (next_value > 0),
  primary key (tenant_id, name)
);

create or replace function private.next_tenant_number(p_tenant uuid, p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_value bigint;
begin
  insert into public.tenant_counters (tenant_id, name, next_value)
  values (p_tenant, p_name, 2)
  on conflict (tenant_id, name)
    do update set next_value = public.tenant_counters.next_value + 1
  returning next_value - 1 into v_value;
  return v_value;
end;
$$;
revoke all on function private.next_tenant_number(uuid, text) from public;
