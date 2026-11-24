-- =============================================================================
-- Phase 7: pilot answers of 24 Nov 2026
--   1. A package that runs out disconnects the customer, like a suspension.
--   2. The pilot ISP authenticates PPPoE customers with RADIUS. FibrePulse
--      becomes the source of "may this customer connect, and at what speed",
--      served to the ISP's RADIUS server by the on-site connector.
--   3. Packages are expired on a schedule, not only when a screen loads.
--   4. Platform fees are calculated and invoiced automatically each month.
-- =============================================================================

create extension if not exists pg_cron;

-- -----------------------------------------------------------------------------
-- Scheduled jobs run as the database owner with no signed-in user. They mark
-- themselves with a transaction setting; API callers connect as
-- "authenticator", so they can never pass this check.
-- -----------------------------------------------------------------------------
create or replace function private.is_system_job()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.uid() is null
     and session_user in ('postgres', 'supabase_admin')
     and coalesce(current_setting('fibrepulse.system_job', true), '') = 'on'
$$;

create or replace function private.require_platform_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.is_platform_admin() or private.is_system_job()) then
    raise exception 'Only FibrePulse super administrators can do this.' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. Expiry disconnects. Only a package whose period genuinely ran out
--    (ended_at >= expires_at) disconnects; a package replaced early by a
--    renewal, upgrade or downgrade does not.
-- -----------------------------------------------------------------------------
create or replace function private.queue_router_command()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enforce boolean;
  v_customer public.customers;
  v_router uuid;
  v_last public.router_commands;
  v_type public.router_command_type;
  v_status public.router_command_status := 'queued';
  v_msg text;
  v_reason text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'suspended' then
    v_type := 'disconnect_pppoe';
    v_reason := new.suspension_reason;
  elsif new.status = 'expired' and new.ended_at is not null and new.ended_at >= new.expires_at then
    if exists (select 1 from public.subscriptions s where s.customer_id = new.customer_id and s.id <> new.id and s.status = 'active') then
      return new; -- another live package keeps them online
    end if;
    v_type := 'disconnect_pppoe';
    v_reason := 'Package ended without renewal';
  elsif new.status = 'active' then
    v_type := 'reconnect_pppoe';
    v_reason := 'Subscription active again';
  else
    return new;
  end if;

  select coalesce((settings ->> 'router_enforcement')::boolean, false) into v_enforce from public.tenants where id = new.tenant_id;
  if not v_enforce then
    return new;
  end if;

  select * into v_last from public.router_commands
  where tenant_id = new.tenant_id and customer_id = new.customer_id and status not in ('cancelled', 'expired')
  order by created_at desc limit 1;

  if v_type = 'reconnect_pppoe' then
    -- Only reconnect someone FibrePulse disconnected (or is about to).
    if v_last.id is null or v_last.command_type <> 'disconnect_pppoe' then
      return new;
    end if;
    if v_last.status in ('queued', 'blocked') then
      update public.router_commands set status = 'cancelled', completed_at = now(), result_message = 'Restored before the router was changed.'
      where id = v_last.id;
      return new;
    end if;
  elsif v_last.id is not null and v_last.command_type = 'disconnect_pppoe' and v_last.status in ('queued', 'sent', 'succeeded') then
    return new; -- already disconnected or on its way
  end if;

  select * into v_customer from public.customers where id = new.customer_id;
  v_router := v_customer.router_id;
  if coalesce(v_customer.pppoe_username, '') = '' then
    v_status := 'blocked';
    v_msg := 'The customer has no PPPoE username. Add it on the customer profile, then retry.';
  elsif v_router is null then
    v_status := 'blocked';
    v_msg := 'FibrePulse does not know which router serves this customer yet. Choose the router on the customer profile, then retry.';
  end if;

  insert into public.router_commands (tenant_id, router_id, customer_id, subscription_id, command_type, pppoe_username, status,
                                      reason, result_message, requested_by, completed_at)
  values (new.tenant_id, v_router, new.customer_id, new.id, v_type, v_customer.pppoe_username, v_status,
          v_reason, v_msg, auth.uid(), null);
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Scheduled expiry for every ISP (every 5 minutes).
-- -----------------------------------------------------------------------------
create or replace function private.expire_all_due_subscriptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.set_audit_reason('Subscription period ended (scheduled check)');
  update public.subscriptions set status = 'expired', ended_at = expires_at
  where status = 'active' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. RADIUS. Each ISP chooses how FibrePulse controls access:
--    'router_secrets' (default): disconnect disables the PPPoE secret on the
--       MikroTik router, reconnect enables it (Phase 4 behaviour).
--    'radius': customers authenticate against the ISP's RADIUS server, which
--       asks the on-site connector whether each username may connect. A
--       disconnect only drops the live session; RADIUS then refuses the
--       reconnect until the customer has a live package.
-- -----------------------------------------------------------------------------
create or replace function public.set_access_control(p_tenant uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission(p_tenant, 'settings:manage');
  if p_mode not in ('router_secrets', 'radius') then
    raise exception 'Choose router PPPoE secrets or RADIUS.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Access control set to ' || p_mode);
  update public.tenants set settings = settings || jsonb_build_object('access_control', p_mode) where id = p_tenant;
end;
$$;

-- Who may connect, for the RADIUS policy the connector serves. One row per
-- customer with a PPPoE username: allowed only with a live (active) package;
-- speeds from that package. Simulated customers are never sent.
create or replace function private.radius_access_list(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'username', c.pppoe_username,
           'allowed', s.id is not null and c.status = 'active',
           'download_mbps', p.download_mbps,
           'upload_mbps', p.upload_mbps,
           'expires_at', s.expires_at) order by c.pppoe_username), '[]'::jsonb)
  from public.customers c
  left join public.subscriptions s on s.customer_id = c.id and s.status = 'active' and s.expires_at > now()
  left join public.service_packages p on p.id = s.package_id
  where c.tenant_id = p_tenant and coalesce(c.pppoe_username, '') <> ''
$$;

create or replace function public.connector_sync(p_token text, p_nonce text, p_ts timestamptz, p_version text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.connector_agents;
  v_enforce boolean;
  v_mode text;
  v_routers jsonb;
  v_commands jsonb;
begin
  v_agent := private.authenticate_connector(p_token, p_nonce, p_ts);
  perform private.set_audit_reason('Connector sync');
  update public.connector_agents
  set status = 'active', last_seen_at = now(), agent_version = left(coalesce(p_version, agent_version), 40)
  where id = v_agent.id and (status <> 'active' or last_seen_at is null or last_seen_at < now() - interval '1 minute'
                             or agent_version is distinct from left(coalesce(p_version, agent_version), 40));
  perform private.clear_alert(v_agent.tenant_id, 'connector_offline:' || v_agent.id, 'Connector is reporting again.');

  select coalesce((t.settings ->> 'router_enforcement')::boolean, false), coalesce(t.settings ->> 'access_control', 'router_secrets')
  into v_enforce, v_mode from public.tenants t where t.id = v_agent.tenant_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'address', host(r.management_address), 'port', r.api_port,
           'scheme', r.api_scheme, 'verify_tls', r.verify_tls, 'simulated', r.data_source = 'simulated',
           'username', c.username, 'secret', c.secret_ciphertext, 'key_version', c.key_version) order by r.name), '[]'::jsonb)
  into v_routers
  from public.routers r
  left join public.router_credentials c on c.router_id = r.id
  where r.tenant_id = v_agent.tenant_id and r.connector_agent_id = v_agent.id and r.monitoring_enabled;

  with picked as (
    update public.router_commands rc
    set status = 'sent', sent_at = now(), attempts = rc.attempts + 1
    from public.routers r
    where rc.router_id = r.id and r.connector_agent_id = v_agent.id and rc.tenant_id = v_agent.tenant_id
      and rc.status = 'queued' and v_enforce
    returning rc.id, rc.router_id, rc.command_type, rc.pppoe_username, rc.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'router_id', router_id, 'type', command_type, 'pppoe_username', pppoe_username) order by created_at), '[]'::jsonb)
  into v_commands from picked;

  return jsonb_build_object(
    'agent_id', v_agent.id,
    'tenant_id', v_agent.tenant_id,
    'poll_interval_seconds', 60,
    'router_enforcement', v_enforce,
    'access_control', v_mode,
    'routers', v_routers,
    'commands', v_commands,
    -- Only sent when the ISP uses RADIUS and has turned enforcement on.
    'radius_access', case when v_mode = 'radius' and v_enforce then private.radius_access_list(v_agent.tenant_id) else null end,
    'server_time', now()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Automatic monthly platform billing. On the 1st (06:00 Kenyan time) every
--    active ISP's previous month is calculated and every uninvoiced fee is
--    invoiced. Each run is recorded; failures for one ISP never stop the rest.
-- -----------------------------------------------------------------------------
create table public.platform_billing_runs (
  id           uuid primary key default gen_random_uuid(),
  period_start date not null,
  trigger      text not null check (trigger in ('schedule', 'manual')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  results      jsonb not null default '[]'::jsonb,
  invoices     integer not null default 0,
  failures     integer not null default 0,
  started_by   uuid references public.profiles (id) on delete set null
);
alter table public.platform_billing_runs enable row level security;
create policy platform_billing_runs_select on public.platform_billing_runs for select to authenticated
  using (private.is_platform_admin());
revoke all on public.platform_billing_runs from anon;

create or replace function public.admin_run_monthly_billing(p_month date default null, p_due_days integer default 14)
returns public.platform_billing_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', coalesce(p_month, ((now() at time zone 'Africa/Nairobi') - interval '1 month')::date))::date;
  v_run public.platform_billing_runs;
  v_results jsonb := '[]'::jsonb;
  v_invoices integer := 0;
  v_failures integer := 0;
  c record;
  t record;
  v_uninvoiced numeric;
  v_invoice text;
  v_invoice_id uuid;
begin
  perform private.require_platform_admin();
  insert into public.platform_billing_runs (period_start, trigger, started_by)
  values (v_month, case when private.is_system_job() then 'schedule' else 'manual' end, auth.uid())
  returning * into v_run;

  for c in select * from public.admin_calculate_all_fees(v_month) loop
    v_results := v_results || jsonb_build_object('tenant_id', c.tenant_id, 'tenant_name', c.tenant_name, 'fees', c.result,
                                                 'total_fee', c.total_fee, 'message', c.message);
    if c.result = 'error' then v_failures := v_failures + 1; end if;
  end loop;

  for t in select id, name from public.tenants where status = 'active' order by name loop
    select coalesce(sum(fee_amount), 0) into v_uninvoiced
    from public.platform_fee_records where tenant_id = t.id and status = 'calculated';
    if v_uninvoiced <= 0 then
      continue;
    end if;
    begin
      v_invoice_id := public.admin_issue_platform_invoice(t.id, p_due_days, 0, 'Issued automatically for fees up to ' || to_char(v_month, 'FMMonth YYYY') || '.');
      select invoice_number into v_invoice from public.platform_invoices where id = v_invoice_id;
      v_invoices := v_invoices + 1;
      v_results := v_results || jsonb_build_object('tenant_id', t.id, 'tenant_name', t.name, 'invoice', v_invoice, 'amount', v_uninvoiced);
    exception when others then
      v_failures := v_failures + 1;
      v_results := v_results || jsonb_build_object('tenant_id', t.id, 'tenant_name', t.name, 'invoice_error', sqlerrm);
    end;
  end loop;

  update public.platform_billing_runs
  set finished_at = now(), results = v_results, invoices = v_invoices, failures = v_failures
  where id = v_run.id
  returning * into v_run;
  return v_run;
end;
$$;

create or replace function private.scheduled_monthly_billing()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('fibrepulse.system_job', 'on', true);
  perform public.admin_run_monthly_billing(null, 14);
end;
$$;

create or replace function private.scheduled_expiry()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('fibrepulse.system_job', 'on', true);
  perform private.expire_all_due_subscriptions();
end;
$$;

-- Schedules (UTC). Re-running this migration replaces them.
do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname in ('fibrepulse-expire-subscriptions', 'fibrepulse-monthly-billing');
  perform cron.schedule('fibrepulse-expire-subscriptions', '*/5 * * * *', 'select private.scheduled_expiry()');
  perform cron.schedule('fibrepulse-monthly-billing', '0 3 1 * *', 'select private.scheduled_monthly_billing()');
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on function private.is_system_job() from public, anon, authenticated;
revoke all on function private.expire_all_due_subscriptions() from public, anon, authenticated;
revoke all on function private.radius_access_list(uuid) from public, anon, authenticated;
revoke all on function private.scheduled_monthly_billing() from public, anon, authenticated;
revoke all on function private.scheduled_expiry() from public, anon, authenticated;
grant execute on function private.is_system_job() to authenticated;
revoke all on function public.set_access_control(uuid, text) from public, anon;
grant execute on function public.set_access_control(uuid, text) to authenticated;
revoke all on function public.admin_run_monthly_billing(date, integer) from public, anon;
grant execute on function public.admin_run_monthly_billing(date, integer) to authenticated;
revoke all on function public.connector_sync(text, text, timestamptz, text) from public;
grant execute on function public.connector_sync(text, text, timestamptz, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- SMS delivery (Safaricom). A separate worker process, holding the service
-- role key, claims pending SMS copies, sends them and records the outcome.
-- Neither function is available to signed-in users or the public.
-- -----------------------------------------------------------------------------
create or replace function public.outbox_claim_sms(p_limit integer default 50)
returns table (id uuid, phone text, title text, body text, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select o.id from public.notification_outbox o
    where o.channel = 'sms' and o.status = 'pending' and o.attempts < 5
      and o.created_at > now() - interval '2 days'
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 500)
    for update skip locked
  ), bumped as (
    update public.notification_outbox o set attempts = o.attempts + 1
    from picked where o.id = picked.id
    returning o.id, o.notification_id, o.recipient_id, o.attempts
  )
  select b.id, p.phone, n.title, n.body, b.attempts
  from bumped b
  join public.notifications n on n.id = b.notification_id
  join public.profiles p on p.id = b.recipient_id;
end;
$$;

create or replace function public.outbox_mark(p_id uuid, p_status text, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped', 'pending') then
    raise exception 'Unknown outbox status %', p_status using errcode = 'check_violation';
  end if;
  update public.notification_outbox
  set status = p_status, last_error = left(p_error, 500), sent_at = case when p_status = 'sent' then now() else sent_at end
  where id = p_id;
end;
$$;

-- Old SMS that never went out are not worth sending late.
update public.notification_outbox set status = 'skipped', last_error = 'Older than 2 days when SMS delivery was set up.'
where channel = 'sms' and status = 'pending' and created_at <= now() - interval '2 days';

revoke all on function public.outbox_claim_sms(integer) from public, anon, authenticated;
revoke all on function public.outbox_mark(uuid, text, text) from public, anon, authenticated;
grant execute on function public.outbox_claim_sms(integer) to service_role;
grant execute on function public.outbox_mark(uuid, text, text) to service_role;
