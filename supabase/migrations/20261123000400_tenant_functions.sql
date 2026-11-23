-- =============================================================================
-- FibrePulse migration 0004: tenant onboarding functions
--
-- These run as SECURITY DEFINER because they must create several related rows
-- atomically (tenant + owner membership + draft agreement). Each checks the
-- caller itself before writing anything.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- register_tenant: a signed-in user creates a new ISP and becomes its owner.
-- The tenant starts as `pending` until a FibrePulse super admin activates it.
-- A draft commercial agreement (2.75% of gross subscription collections,
-- the pilot default) is created for the platform team to review and sign.
-- -----------------------------------------------------------------------------
create or replace function public.register_tenant(
  p_name          text,
  p_slug          text,
  p_county        text default null,
  p_town          text default null,
  p_contact_phone text default null,
  p_owner_name    text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_tenant_id uuid;
  v_owned     integer;
  v_email     text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to register an ISP.' using errcode = 'insufficient_privilege';
  end if;

  -- Abuse guard: one person may own at most 3 ISPs.
  select count(*) into v_owned from public.tenant_members
  where profile_id = v_uid and role = 'owner';
  if v_owned >= 3 then
    raise exception 'You already own the maximum number of ISP accounts.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.tenants where slug = lower(p_slug)) then
    raise exception 'That workspace address is already taken.' using errcode = 'unique_violation';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.tenants (name, slug, county, town, contact_phone, contact_email, status, created_by)
  values (trim(p_name), lower(trim(p_slug)), nullif(trim(p_county), ''), nullif(trim(p_town), ''),
          nullif(trim(p_contact_phone), ''), v_email, 'pending', v_uid)
  returning id into v_tenant_id;

  insert into public.tenant_members (tenant_id, profile_id, role, status)
  values (v_tenant_id, v_uid, 'owner', 'active');

  if p_owner_name is not null and trim(p_owner_name) <> '' then
    update public.profiles set full_name = left(trim(p_owner_name), 120)
    where id = v_uid and full_name = '';
  end if;

  insert into public.commercial_agreements (tenant_id, version, status, fee_rate, fee_basis, effective_from, notes, created_by)
  values (v_tenant_id, 1, 'draft', 0.0275, 'gross',
          (now() at time zone 'Africa/Nairobi')::date,
          'Default pilot terms: 2.75% of gross verified subscription collections. Draft until signed.',
          v_uid);

  return v_tenant_id;
end;
$$;

revoke all on function public.register_tenant(text, text, text, text, text, text) from public, anon;
grant execute on function public.register_tenant(text, text, text, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- accept_invitation: the invited person accepts with a confirmed email that
-- matches the invitation.
-- -----------------------------------------------------------------------------
create or replace function public.accept_invitation(p_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_confirmed timestamptz;
  v_inv       public.tenant_invitations;
begin
  if v_uid is null then
    raise exception 'You must be signed in to accept an invitation.' using errcode = 'insufficient_privilege';
  end if;

  select email, email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;
  if v_confirmed is null then
    raise exception 'Confirm your email address before accepting an invitation.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_inv from public.tenant_invitations where id = p_invitation_id for update;
  if not found
     or v_inv.accepted_at is not null
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now()
     or lower(v_inv.email::text) <> lower(v_email) then
    raise exception 'This invitation is not valid for your account.' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.tenants where id = v_inv.tenant_id and status in ('pending', 'active')) then
    raise exception 'This ISP account is not active.' using errcode = 'insufficient_privilege';
  end if;

  insert into public.tenant_members (tenant_id, profile_id, role, status, invited_by)
  values (v_inv.tenant_id, v_uid, v_inv.role, 'active', v_inv.invited_by)
  on conflict (tenant_id, profile_id) do update
    set role = excluded.role, status = 'active', invited_by = excluded.invited_by
    where public.tenant_members.role <> 'owner';

  update public.tenant_invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_inv.id;

  if v_inv.role = 'technician' then
    insert into public.technicians (tenant_id, profile_id)
    values (v_inv.tenant_id, v_uid)
    on conflict (tenant_id, profile_id) do update set active = true;
  end if;

  return v_inv.tenant_id;
end;
$$;

revoke all on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- my_permissions: the caller's permission strings in one tenant. Used by the
-- server to build navigation; the database still checks every query itself.
-- -----------------------------------------------------------------------------
create or replace function public.my_permissions(p_tenant uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(rp.permission order by rp.permission), '{}')
  from private.role_permissions rp
  where rp.role = private.tenant_role_of(p_tenant)
$$;

revoke all on function public.my_permissions(uuid) from public, anon;
grant execute on function public.my_permissions(uuid) to authenticated;
