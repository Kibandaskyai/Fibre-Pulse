-- =============================================================================
-- FibrePulse migration 0003: permissions and Row Level Security
--
-- The role -> permission matrix lives in private.role_permissions and MUST
-- match src/lib/auth/permissions.ts. A test (tests/db/permissions-sync.test.ts)
-- fails if they drift.
--
-- Rules:
--   * RLS is enabled on every table in `public`.
--   * Anonymous users get no table access at all.
--   * Platform staff (profiles.platform_role) are NOT tenant members and see
--     no ISP operational data, except read-only access to a small set of
--     tables while an owner-approved support grant is live.
--   * Writes that need several rows to change together go through
--     SECURITY DEFINER functions (register_tenant, accept_invitation).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Permission matrix
-- -----------------------------------------------------------------------------
create table private.role_permissions (
  role       public.tenant_role not null,
  permission text not null,
  primary key (role, permission)
);

insert into private.role_permissions (role, permission)
select 'owner'::public.tenant_role, p from unnest(array[
  'staff:manage', 'settings:manage', 'audit:view',
  'customers:view', 'customers:edit', 'customers:view_location',
  'packages:view', 'packages:edit',
  'subscriptions:view', 'subscriptions:edit', 'subscriptions:suspend',
  'invoices:view', 'invoices:edit',
  'payments:view', 'payments:record', 'payments:reconcile',
  'revenue:view',
  'network:view', 'network:edit', 'network:credentials',
  'alerts:view', 'alerts:manage',
  'tickets:view', 'tickets:edit',
  'jobs:view', 'jobs:edit',
  'reports:financial', 'reports:network', 'reports:support',
  'platform_billing:view'
]) as p
union all
select 'finance', p from unnest(array[
  'customers:view', 'packages:view', 'subscriptions:view',
  'invoices:view', 'invoices:edit',
  'payments:view', 'payments:record', 'payments:reconcile',
  'revenue:view', 'reports:financial', 'tickets:view',
  'platform_billing:view'
]) as p
union all
select 'network_admin', p from unnest(array[
  'customers:view', 'customers:view_location', 'packages:view', 'subscriptions:view',
  'network:view', 'network:edit', 'network:credentials',
  'alerts:view', 'alerts:manage',
  'tickets:view', 'tickets:edit', 'jobs:view', 'jobs:edit',
  'reports:network'
]) as p
union all
select 'support_agent', p from unnest(array[
  'customers:view', 'packages:view', 'subscriptions:view',
  'network:view', 'alerts:view',
  'tickets:view', 'tickets:edit', 'jobs:view', 'jobs:edit',
  'reports:support'
]) as p
union all
select 'technician', p from unnest(array[
  'network:view', 'alerts:view', 'jobs:update_own'
]) as p;

-- -----------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so policies can read membership tables
-- without recursive RLS evaluation). All are STABLE and pin search_path.
-- -----------------------------------------------------------------------------

-- The caller's role in a tenant, or null. Suspended and deactivated tenants
-- give no access.
create or replace function private.tenant_role_of(p_tenant uuid)
returns public.tenant_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  where m.tenant_id = p_tenant
    and m.profile_id = auth.uid()
    and m.status = 'active'
    and t.status in ('pending', 'active')
$$;

create or replace function private.is_member(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.tenant_role_of(p_tenant) is not null
$$;

create or replace function private.has_permission(p_tenant uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.role_permissions rp
    where rp.role = private.tenant_role_of(p_tenant)
      and rp.permission = p_permission
  )
$$;

create or replace function private.platform_role_of()
returns public.platform_role
language sql
stable
security definer
set search_path = ''
as $$
  select platform_role from public.profiles where id = auth.uid()
$$;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.platform_role_of() = 'super_admin', false)
$$;

create or replace function private.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.platform_role_of() is not null
$$;

-- True while an owner-approved, unexpired, unrevoked support grant exists
-- for the calling platform staff member.
create or replace function private.has_support_grant(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_staff() and exists (
    select 1 from public.support_access_grants g
    where g.tenant_id = p_tenant
      and g.granted_to = auth.uid()
      and g.approved_at is not null
      and g.revoked_at is null
      and g.expires_at > now()
  )
$$;

create or replace function private.my_technician_id(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from public.technicians t
  where t.tenant_id = p_tenant and t.profile_id = auth.uid() and t.active
    and private.is_member(p_tenant)
$$;

-- A technician may see a customer only while they have an open job there.
create or replace function private.is_assigned_technician(p_tenant uuid, p_customer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.installation_jobs j
    where j.tenant_id = p_tenant
      and j.customer_id = p_customer
      and j.technician_id = private.my_technician_id(p_tenant)
      and j.status in ('scheduled', 'in_progress', 'on_hold')
  )
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
grant select on private.role_permissions to service_role;

-- -----------------------------------------------------------------------------
-- Guards that RLS alone cannot express
-- -----------------------------------------------------------------------------

-- Only platform super admins (or the service role) can change tenant status
-- or slug.
create or replace function private.guard_tenant_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() = 'authenticated' and not private.is_platform_admin() and (
       new.status         is distinct from old.status
    or new.slug           is distinct from old.slug
    or new.activated_at   is distinct from old.activated_at
    or new.deactivated_at is distinct from old.deactivated_at
    or new.created_by     is distinct from old.created_by
  ) then
    raise exception 'Only FibrePulse administrators can change tenant status or slug.'
      using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'active' and old.status <> 'active' and new.activated_at is null then
    new.activated_at := now();
  end if;
  if new.status = 'deactivated' and old.status <> 'deactivated' and new.deactivated_at is null then
    new.deactivated_at := now();
  end if;
  return new;
end;
$$;
create trigger tenants_guard before update on public.tenants
  for each row execute function private.guard_tenant_update();

-- Users can edit their own profile but never grant themselves a platform role.
create or replace function private.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() = 'authenticated' and (
       new.platform_role is distinct from old.platform_role
    or new.email is distinct from old.email
    or new.id is distinct from old.id) then
    raise exception 'Platform role and email cannot be changed here.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger profiles_guard before update on public.profiles
  for each row execute function private.guard_profile_update();

-- Every live tenant keeps at least one active owner.
create or replace function private.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  if not exists (select 1 from public.tenants where id = v_tenant) then
    return null; -- tenant itself is being deleted
  end if;
  if not exists (
    select 1 from public.tenant_members
    where tenant_id = v_tenant and role = 'owner' and status = 'active'
  ) then
    raise exception 'An ISP must keep at least one active owner.'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger tenant_members_last_owner
  after update or delete on public.tenant_members
  deferrable initially deferred
  for each row execute function private.guard_last_owner();

-- Staff managers cannot change their own role or disable themselves
-- (prevents accidental lock-out; another owner must do it).
create or replace function private.guard_member_self_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() = 'authenticated' and old.profile_id = auth.uid() and (
       new.role is distinct from old.role or new.status is distinct from old.status) then
    raise exception 'You cannot change your own role or status.'
      using errcode = 'insufficient_privilege';
  end if;
  if new.tenant_id is distinct from old.tenant_id or new.profile_id is distinct from old.profile_id then
    raise exception 'Membership tenant and person cannot be changed.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger tenant_members_self_guard before update on public.tenant_members
  for each row execute function private.guard_member_self_change();

-- Technicians may only progress their own job; they cannot reassign it or
-- edit its customer, type or schedule.
create or replace function private.guard_technician_job_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() = 'authenticated' and not private.has_permission(old.tenant_id, 'jobs:edit') and (
       new.technician_id is distinct from old.technician_id
    or new.customer_id   is distinct from old.customer_id
    or new.ticket_id     is distinct from old.ticket_id
    or new.job_type      is distinct from old.job_type
    or new.scheduled_for is distinct from old.scheduled_for
    or new.address       is distinct from old.address
    or new.tenant_id     is distinct from old.tenant_id
    or new.job_number    is distinct from old.job_number) then
    raise exception 'Technicians can only update progress and notes on their own jobs.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger installation_jobs_technician_guard before update on public.installation_jobs
  for each row execute function private.guard_technician_job_update();

-- Notification recipients may only mark notifications read.
create or replace function private.guard_notification_update()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'authenticated' and (
       new.title is distinct from old.title or new.body is distinct from old.body
    or new.recipient_id is distinct from old.recipient_id or new.tenant_id is distinct from old.tenant_id
    or new.type is distinct from old.type or new.link is distinct from old.link) then
    raise exception 'Only the read status of a notification can be changed.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger notifications_guard before update on public.notifications
  for each row execute function private.guard_notification_update();

-- -----------------------------------------------------------------------------
-- Grants: no anonymous table access anywhere. Audit log is append-only.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
revoke update, delete, truncate on public.audit_logs from authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS on every table
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    -- Not FORCE: SECURITY DEFINER functions owned by the migration role must
    -- be able to write audit rows and counters.
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Policies: identity and tenancy
-- -----------------------------------------------------------------------------
create policy tenants_select on public.tenants for select to authenticated
  using (private.is_member(id) or private.is_platform_staff());
create policy tenants_update on public.tenants for update to authenticated
  using (private.has_permission(id, 'settings:manage') or private.is_platform_admin())
  with check (private.has_permission(id, 'settings:manage') or private.is_platform_admin());

create policy profiles_select on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or private.is_platform_staff()
    or exists (
      select 1 from public.tenant_members m
      where m.profile_id = profiles.id and private.is_member(m.tenant_id)
    )
  );
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy tenant_members_select on public.tenant_members for select to authenticated
  using (private.is_member(tenant_id) or profile_id = auth.uid());
create policy tenant_members_update on public.tenant_members for update to authenticated
  using (private.has_permission(tenant_id, 'staff:manage'))
  with check (private.has_permission(tenant_id, 'staff:manage'));
create policy tenant_members_delete on public.tenant_members for delete to authenticated
  using (private.has_permission(tenant_id, 'staff:manage') and profile_id <> auth.uid());

create policy tenant_invitations_select on public.tenant_invitations for select to authenticated
  using (
    private.has_permission(tenant_id, 'staff:manage')
    or (email = (select p.email from public.profiles p where p.id = auth.uid())
        and accepted_at is null and revoked_at is null and expires_at > now())
  );
create policy tenant_invitations_insert on public.tenant_invitations for insert to authenticated
  with check (private.has_permission(tenant_id, 'staff:manage') and invited_by = auth.uid()
              and accepted_at is null and revoked_at is null);
create policy tenant_invitations_update on public.tenant_invitations for update to authenticated
  using (private.has_permission(tenant_id, 'staff:manage'))
  with check (private.has_permission(tenant_id, 'staff:manage') and accepted_at is null);

create policy support_grants_select on public.support_access_grants for select to authenticated
  using (private.has_permission(tenant_id, 'staff:manage') or granted_to = auth.uid());
create policy support_grants_request on public.support_access_grants for insert to authenticated
  with check (private.is_platform_staff() and granted_to = auth.uid()
              and approved_at is null and approved_by is null and revoked_at is null);
create policy support_grants_decide on public.support_access_grants for update to authenticated
  using (private.has_permission(tenant_id, 'staff:manage'))
  with check (private.has_permission(tenant_id, 'staff:manage')
              and (approved_by is null or approved_by = auth.uid()));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    (tenant_id is not null and private.has_permission(tenant_id, 'audit:view')
       and entity_type not in ('commercial_agreements', 'platform_fee_records', 'platform_invoices'))
    or (private.is_platform_admin()
       and entity_type in ('tenants', 'commercial_agreements', 'platform_fee_records', 'platform_invoices'))
  );

-- tenant_counters: no policies. Only reachable through SECURITY DEFINER functions.

-- -----------------------------------------------------------------------------
-- Policies: customers, packages, subscriptions
-- -----------------------------------------------------------------------------
create policy customers_select on public.customers for select to authenticated
  using (private.has_permission(tenant_id, 'customers:view')
         or private.is_assigned_technician(tenant_id, id)
         or private.has_support_grant(tenant_id));
create policy customers_insert on public.customers for insert to authenticated
  with check (private.has_permission(tenant_id, 'customers:edit') and data_source = 'manual');
create policy customers_update on public.customers for update to authenticated
  using (private.has_permission(tenant_id, 'customers:edit'))
  with check (private.has_permission(tenant_id, 'customers:edit'));

create policy customer_locations_select on public.customer_locations for select to authenticated
  using (private.has_permission(tenant_id, 'customers:view_location')
         or private.is_assigned_technician(tenant_id, customer_id));
create policy customer_locations_write on public.customer_locations for all to authenticated
  using (private.has_permission(tenant_id, 'customers:edit') and private.has_permission(tenant_id, 'customers:view_location'))
  with check (private.has_permission(tenant_id, 'customers:edit') and private.has_permission(tenant_id, 'customers:view_location'));

create policy service_packages_select on public.service_packages for select to authenticated
  using (private.has_permission(tenant_id, 'packages:view') or private.has_support_grant(tenant_id));
create policy service_packages_insert on public.service_packages for insert to authenticated
  with check (private.has_permission(tenant_id, 'packages:edit'));
create policy service_packages_update on public.service_packages for update to authenticated
  using (private.has_permission(tenant_id, 'packages:edit'))
  with check (private.has_permission(tenant_id, 'packages:edit'));

create policy subscriptions_select on public.subscriptions for select to authenticated
  using (private.has_permission(tenant_id, 'subscriptions:view') or private.has_support_grant(tenant_id));
create policy subscriptions_insert on public.subscriptions for insert to authenticated
  with check (private.has_permission(tenant_id, 'subscriptions:edit'));
create policy subscriptions_update on public.subscriptions for update to authenticated
  using (private.has_permission(tenant_id, 'subscriptions:edit'))
  with check (private.has_permission(tenant_id, 'subscriptions:edit'));

-- -----------------------------------------------------------------------------
-- Policies: billing and payments
-- -----------------------------------------------------------------------------
create policy invoices_select on public.invoices for select to authenticated
  using (private.has_permission(tenant_id, 'invoices:view'));
create policy invoices_insert on public.invoices for insert to authenticated
  with check (private.has_permission(tenant_id, 'invoices:edit'));
create policy invoices_update on public.invoices for update to authenticated
  using (private.has_permission(tenant_id, 'invoices:edit'))
  with check (private.has_permission(tenant_id, 'invoices:edit'));

create policy invoice_lines_select on public.invoice_lines for select to authenticated
  using (private.has_permission(tenant_id, 'invoices:view'));
create policy invoice_lines_write on public.invoice_lines for all to authenticated
  using (private.has_permission(tenant_id, 'invoices:edit'))
  with check (private.has_permission(tenant_id, 'invoices:edit'));

create policy payments_select on public.payments for select to authenticated
  using (private.has_permission(tenant_id, 'payments:view'));
-- People can only record manual, unverified payments. Provider-sourced
-- payments (M-Pesa callbacks) are written by the server with the service role.
create policy payments_insert on public.payments for insert to authenticated
  with check (private.has_permission(tenant_id, 'payments:record')
              and data_source = 'manual'
              and recorded_by = auth.uid()
              and verification_status = 'unverified');
create policy payments_update on public.payments for update to authenticated
  using (private.has_permission(tenant_id, 'payments:reconcile'))
  with check (private.has_permission(tenant_id, 'payments:reconcile'));

create policy payment_allocations_select on public.payment_allocations for select to authenticated
  using (private.has_permission(tenant_id, 'payments:view'));
create policy payment_allocations_insert on public.payment_allocations for insert to authenticated
  with check (private.has_permission(tenant_id, 'payments:record'));

create policy payment_reconciliation_select on public.payment_reconciliation_records for select to authenticated
  using (private.has_permission(tenant_id, 'payments:view'));
create policy payment_reconciliation_insert on public.payment_reconciliation_records for insert to authenticated
  with check (private.has_permission(tenant_id, 'payments:reconcile') and matched_by = auth.uid());

-- -----------------------------------------------------------------------------
-- Policies: network
-- -----------------------------------------------------------------------------
create policy connector_agents_select on public.connector_agents for select to authenticated
  using (private.has_permission(tenant_id, 'network:view'));
create policy connector_agents_insert on public.connector_agents for insert to authenticated
  with check (private.has_permission(tenant_id, 'network:edit'));
create policy connector_agents_update on public.connector_agents for update to authenticated
  using (private.has_permission(tenant_id, 'network:edit'))
  with check (private.has_permission(tenant_id, 'network:edit'));

create policy routers_select on public.routers for select to authenticated
  using (private.has_permission(tenant_id, 'network:view') or private.has_support_grant(tenant_id));
create policy routers_insert on public.routers for insert to authenticated
  with check (private.has_permission(tenant_id, 'network:edit') and data_source in ('manual', 'simulated'));
create policy routers_update on public.routers for update to authenticated
  using (private.has_permission(tenant_id, 'network:edit'))
  with check (private.has_permission(tenant_id, 'network:edit'));

-- router_credentials: insert/update allowed with network:credentials, but
-- there is deliberately NO select policy, so values can never be read back.
create policy router_credentials_insert on public.router_credentials for insert to authenticated
  with check (private.has_permission(tenant_id, 'network:credentials') and updated_by = auth.uid());
create policy router_credentials_update on public.router_credentials for update to authenticated
  using (private.has_permission(tenant_id, 'network:credentials'))
  with check (private.has_permission(tenant_id, 'network:credentials') and updated_by = auth.uid());

create policy router_interfaces_select on public.router_interfaces for select to authenticated
  using (private.has_permission(tenant_id, 'network:view') or private.has_support_grant(tenant_id));
create policy network_sessions_select on public.network_sessions for select to authenticated
  using (private.has_permission(tenant_id, 'network:view') or private.has_support_grant(tenant_id));
create policy network_metrics_select on public.network_metrics for select to authenticated
  using (private.has_permission(tenant_id, 'network:view') or private.has_support_grant(tenant_id));
-- Interfaces, sessions and metrics are written only by the connector ingest
-- path (service role) or the simulator.

create policy network_alerts_select on public.network_alerts for select to authenticated
  using (private.has_permission(tenant_id, 'alerts:view') or private.has_support_grant(tenant_id));
create policy network_alerts_insert on public.network_alerts for insert to authenticated
  with check (private.has_permission(tenant_id, 'alerts:manage') and data_source = 'manual');
create policy network_alerts_update on public.network_alerts for update to authenticated
  using (private.has_permission(tenant_id, 'alerts:manage'))
  with check (private.has_permission(tenant_id, 'alerts:manage'));

-- -----------------------------------------------------------------------------
-- Policies: support and field operations
-- -----------------------------------------------------------------------------
create policy technicians_select on public.technicians for select to authenticated
  using (private.has_permission(tenant_id, 'jobs:view') or (profile_id = auth.uid() and private.is_member(tenant_id)));
create policy technicians_write on public.technicians for all to authenticated
  using (private.has_permission(tenant_id, 'staff:manage'))
  with check (private.has_permission(tenant_id, 'staff:manage'));

create policy support_tickets_select on public.support_tickets for select to authenticated
  using (private.has_permission(tenant_id, 'tickets:view')
         or (assigned_to = auth.uid() and private.is_member(tenant_id)));
create policy support_tickets_insert on public.support_tickets for insert to authenticated
  with check (private.has_permission(tenant_id, 'tickets:edit') and created_by = auth.uid());
create policy support_tickets_update on public.support_tickets for update to authenticated
  using (private.has_permission(tenant_id, 'tickets:edit')
         or (assigned_to = auth.uid() and private.is_member(tenant_id)))
  with check (private.has_permission(tenant_id, 'tickets:edit')
         or (assigned_to = auth.uid() and private.is_member(tenant_id)));

create policy installation_jobs_select on public.installation_jobs for select to authenticated
  using (private.has_permission(tenant_id, 'jobs:view')
         or technician_id = private.my_technician_id(tenant_id));
create policy installation_jobs_insert on public.installation_jobs for insert to authenticated
  with check (private.has_permission(tenant_id, 'jobs:edit') and created_by = auth.uid());
create policy installation_jobs_update on public.installation_jobs for update to authenticated
  using (private.has_permission(tenant_id, 'jobs:edit')
         or (private.has_permission(tenant_id, 'jobs:update_own') and technician_id = private.my_technician_id(tenant_id)))
  with check (private.has_permission(tenant_id, 'jobs:edit')
         or (private.has_permission(tenant_id, 'jobs:update_own') and technician_id = private.my_technician_id(tenant_id)));

-- -----------------------------------------------------------------------------
-- Policies: notifications (personal inbox)
-- -----------------------------------------------------------------------------
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = auth.uid() and (tenant_id is null or private.is_member(tenant_id)));
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Policies: FibrePulse commercial tables
-- ISP owners and finance can read their own agreement and platform invoices.
-- Only platform super admins can write them. Support admins see none.
-- -----------------------------------------------------------------------------
create policy commercial_agreements_select on public.commercial_agreements for select to authenticated
  using (private.is_platform_admin() or private.has_permission(tenant_id, 'platform_billing:view'));
create policy commercial_agreements_insert on public.commercial_agreements for insert to authenticated
  with check (private.is_platform_admin());
create policy commercial_agreements_update on public.commercial_agreements for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());

create policy platform_fee_records_select on public.platform_fee_records for select to authenticated
  using (private.is_platform_admin() or private.has_permission(tenant_id, 'platform_billing:view'));
create policy platform_fee_records_insert on public.platform_fee_records for insert to authenticated
  with check (private.is_platform_admin());
create policy platform_fee_records_update on public.platform_fee_records for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());

create policy platform_invoices_select on public.platform_invoices for select to authenticated
  using (private.is_platform_admin()
         or (private.has_permission(tenant_id, 'platform_billing:view') and status <> 'draft'));
create policy platform_invoices_insert on public.platform_invoices for insert to authenticated
  with check (private.is_platform_admin());
create policy platform_invoices_update on public.platform_invoices for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
