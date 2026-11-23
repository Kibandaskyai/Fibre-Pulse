-- =============================================================================
-- FibrePulse migration 0005: platform administration functions
--
-- FibrePulse staff are not members of any ISP, so RLS hides ISP membership
-- rows from them. These functions return only what the platform team needs
-- (tenant list, owner contact, staff count) and never customer, payment or
-- network data.
-- =============================================================================

create or replace function public.admin_list_tenants()
returns table (
  id uuid,
  name text,
  slug text,
  status public.tenant_status,
  county text,
  town text,
  owner_name text,
  owner_email text,
  staff_count integer,
  created_at timestamptz,
  activated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_staff() then
    raise exception 'FibrePulse staff only.' using errcode = 'insufficient_privilege';
  end if;
  return query
  select t.id, t.name, t.slug, t.status, t.county, t.town,
         o.full_name, o.email::text,
         (select count(*)::integer from public.tenant_members m where m.tenant_id = t.id and m.status = 'active'),
         t.created_at, t.activated_at
  from public.tenants t
  left join lateral (
    select p.full_name, p.email
    from public.tenant_members m
    join public.profiles p on p.id = m.profile_id
    where m.tenant_id = t.id and m.role = 'owner' and m.status = 'active'
    order by m.created_at
    limit 1
  ) o on true
  order by t.created_at desc;
end;
$$;

revoke all on function public.admin_list_tenants() from public, anon;
grant execute on function public.admin_list_tenants() to authenticated;

-- Change a tenant's status with a recorded reason. Super admins only.
create or replace function public.admin_set_tenant_status(p_tenant uuid, p_status public.tenant_status, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Only FibrePulse super administrators can change tenant status.' using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  perform set_config('fibrepulse.audit_reason', left(trim(p_reason), 500), true);
  update public.tenants set status = p_status where id = p_tenant;
  if not found then
    raise exception 'ISP not found.' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.admin_set_tenant_status(uuid, public.tenant_status, text) from public, anon;
grant execute on function public.admin_set_tenant_status(uuid, public.tenant_status, text) to authenticated;
