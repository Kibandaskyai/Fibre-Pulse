-- =============================================================================
-- FibrePulse Phase 4: network intelligence
--
-- The FibrePulse Connector Agent runs inside the ISP's network, polls MikroTik
-- routers locally and calls three functions through the public API with its
-- own token (never a user session and never the service role):
--
--   connector_sync(token, nonce, ts, version)          config + queued commands
--   connector_ingest(token, nonce, ts, payload)        telemetry
--   connector_command_result(token, nonce, ts, ...)   outcome of a command
--
-- Each call checks the token (stored only as a SHA-256 hash), a timestamp
-- within 5 minutes, a nonce never used before (replay protection) and a rate
-- limit. The route handlers in src/app/api/connector also check an HMAC
-- signature over the request body before calling these.
--
-- Router commands are limited to disconnecting and reconnecting a PPPoE
-- customer when their subscription is suspended or restored, as required by
-- the pilot ISP (23 Nov 2026). They run only when the ISP owner has turned on
-- router enforcement AND the connector is started with writes allowed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Schema additions
-- -----------------------------------------------------------------------------
alter table public.routers
  add column api_scheme text not null default 'https' check (api_scheme in ('https', 'http')),
  add column verify_tls boolean not null default false,
  add column consecutive_failures integer not null default 0 check (consecutive_failures >= 0);
comment on column public.routers.verify_tls is 'RouterOS ships a self-signed certificate; turn on once a trusted certificate is installed.';

-- Which router holds the customer's PPPoE secret. Learned from sessions, or set by staff.
alter table public.customers add column router_id uuid;
alter table public.customers
  add constraint customers_router_fk foreign key (tenant_id, router_id)
  references public.routers (tenant_id, id) on delete set null (router_id);

-- Stable key for automatic alerts so the same problem opens one alert.
alter table public.network_alerts add column dedupe_key text;
create unique index network_alerts_dedupe_open
  on public.network_alerts (tenant_id, dedupe_key)
  where dedupe_key is not null and status <> 'resolved';

-- Replay protection and rate limiting for connector calls. Not readable by anyone.
create table private.connector_nonces (
  agent_id uuid not null references public.connector_agents (id) on delete cascade,
  nonce    text not null check (char_length(nonce) between 16 and 64),
  seen_at  timestamptz not null default now(),
  primary key (agent_id, nonce)
);
create index connector_nonces_seen_idx on private.connector_nonces (agent_id, seen_at);

create table private.watchdog_runs (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  ran_at    timestamptz not null
);

-- Telemetry updates routers and connector_agents every minute. Audit only
-- the changes people make, not the readings.
drop trigger routers_audit on public.routers;
create trigger routers_audit after insert or delete on public.routers
  for each row execute function private.audit_row_change();
create trigger routers_audit_update after update on public.routers
  for each row when (
    (old.name, old.connector_agent_id, old.management_address, old.api_port, old.api_scheme, old.verify_tls,
     old.monitoring_enabled, old.location_name, old.latitude, old.longitude, old.data_source)
    is distinct from
    (new.name, new.connector_agent_id, new.management_address, new.api_port, new.api_scheme, new.verify_tls,
     new.monitoring_enabled, new.location_name, new.latitude, new.longitude, new.data_source))
  execute function private.audit_row_change();
drop trigger connector_agents_audit on public.connector_agents;
create trigger connector_agents_audit after insert or delete on public.connector_agents
  for each row execute function private.audit_row_change();
create trigger connector_agents_audit_update after update on public.connector_agents
  for each row when ((old.name, old.status, old.token_hash) is distinct from (new.name, new.status, new.token_hash))
  execute function private.audit_row_change();

create type public.router_command_type as enum ('disconnect_pppoe', 'reconnect_pppoe');
create type public.router_command_status as enum ('queued', 'sent', 'succeeded', 'failed', 'cancelled', 'expired', 'blocked');

create table public.router_commands (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete restrict,
  router_id       uuid,
  customer_id     uuid not null,
  subscription_id uuid,
  command_type    public.router_command_type not null,
  pppoe_username  text,
  status          public.router_command_status not null default 'queued',
  attempts        integer not null default 0 check (attempts >= 0),
  reason          text,
  result_message  text,
  requested_by    uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  completed_at    timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, router_id) references public.routers (tenant_id, id) on delete set null (router_id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete cascade,
  foreign key (tenant_id, subscription_id) references public.subscriptions (tenant_id, id) on delete set null (subscription_id)
);
create index router_commands_customer_idx on public.router_commands (tenant_id, customer_id, created_at desc);
create index router_commands_pending_idx on public.router_commands (router_id, status) where status in ('queued', 'sent');
create trigger router_commands_audit after insert or update or delete on public.router_commands
  for each row execute function private.audit_row_change();

alter table public.router_commands enable row level security;
create policy router_commands_select on public.router_commands for select to authenticated
  using (private.has_permission(tenant_id, 'network:view') or private.has_permission(tenant_id, 'customers:view'));
-- No write policies: commands are created by the subscription trigger and
-- changed only by the connector functions and retry_router_command().
revoke all on public.router_commands from anon;

-- -----------------------------------------------------------------------------
-- Small safe casts (bad values from a device must never abort a whole batch)
-- -----------------------------------------------------------------------------
create or replace function private.try_inet(p text)
returns inet language plpgsql immutable set search_path = '' as $$
begin
  return nullif(trim(p), '')::inet;
exception when others then
  return null;
end;
$$;

create or replace function private.try_macaddr(p text)
returns macaddr language plpgsql immutable set search_path = '' as $$
begin
  return nullif(trim(p), '')::macaddr;
exception when others then
  return null;
end;
$$;

create or replace function private.try_numeric(p text)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  return nullif(trim(p), '')::numeric;
exception when others then
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Alerts and notifications
-- -----------------------------------------------------------------------------
create or replace function private.raise_alert(
  p_tenant uuid, p_router uuid, p_key text, p_type text, p_severity public.alert_severity,
  p_title text, p_message text, p_source public.data_source
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.network_alerts (tenant_id, router_id, severity, alert_type, title, message, data_source, dedupe_key)
  values (p_tenant, p_router, p_severity, p_type, left(p_title, 160), left(p_message, 500), p_source, p_key)
  on conflict (tenant_id, dedupe_key) where dedupe_key is not null and status <> 'resolved' do nothing
  returning id into v_id;

  -- Tell the people who manage alerts about new warnings and outages.
  if v_id is not null and p_severity in ('warning', 'critical') then
    insert into public.notifications (tenant_id, recipient_id, type, title, body, link)
    select p_tenant, m.profile_id,
           case when p_type in ('router_offline', 'connector_offline') then 'router_offline' else 'critical_network_warning' end,
           left(p_title, 160),
           case when p_source = 'simulated' then 'SIMULATED test data. ' else '' end || coalesce(left(p_message, 300), ''),
           '/alerts'
    from public.tenant_members m
    join private.role_permissions rp on rp.role = m.role and rp.permission = 'alerts:manage'
    where m.tenant_id = p_tenant and m.status = 'active';
  end if;
end;
$$;

create or replace function private.clear_alert(p_tenant uuid, p_key text, p_message text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.network_alerts
  set status = 'resolved', resolved_at = now(),
      message = left(coalesce(message || ' ', '') || p_message, 500)
  where tenant_id = p_tenant and dedupe_key = p_key and status <> 'resolved';
$$;

-- -----------------------------------------------------------------------------
-- Connector authentication
-- -----------------------------------------------------------------------------
create or replace function private.authenticate_connector(p_token text, p_nonce text, p_ts timestamptz)
returns public.connector_agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.connector_agents;
  v_recent int;
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception 'Connector not recognised.' using errcode = 'invalid_authorization_specification';
  end if;
  select a.* into v_agent
  from public.connector_agents a
  join public.tenants t on t.id = a.tenant_id
  where a.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and a.status <> 'revoked'
    and t.status = 'active';
  if v_agent.id is null then
    raise exception 'Connector not recognised.' using errcode = 'invalid_authorization_specification';
  end if;
  if p_ts is null or abs(extract(epoch from (now() - p_ts))) > 300 then
    raise exception 'Request time is more than 5 minutes off. Check the clock on the connector machine.' using errcode = 'invalid_authorization_specification';
  end if;
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' then
    raise exception 'Invalid nonce.' using errcode = 'invalid_authorization_specification';
  end if;
  select count(*) into v_recent from private.connector_nonces where agent_id = v_agent.id and seen_at > now() - interval '1 minute';
  if v_recent >= 120 then
    raise exception 'Too many requests from this connector. Slow down.' using errcode = 'program_limit_exceeded';
  end if;
  begin
    insert into private.connector_nonces (agent_id, nonce) values (v_agent.id, p_nonce);
  exception when unique_violation then
    raise exception 'This request was already received (replay refused).' using errcode = 'invalid_authorization_specification';
  end;
  return v_agent;
end;
$$;

-- -----------------------------------------------------------------------------
-- connector_sync: heartbeat, configuration and commands
-- -----------------------------------------------------------------------------
create or replace function public.connector_sync(p_token text, p_nonce text, p_ts timestamptz, p_version text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.connector_agents;
  v_enforce boolean;
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

  select coalesce((t.settings ->> 'router_enforcement')::boolean, false) into v_enforce from public.tenants t where t.id = v_agent.tenant_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'address', host(r.management_address), 'port', r.api_port,
           'scheme', r.api_scheme, 'verify_tls', r.verify_tls, 'simulated', r.data_source = 'simulated',
           'username', c.username, 'secret', c.secret_ciphertext, 'key_version', c.key_version) order by r.name), '[]'::jsonb)
  into v_routers
  from public.routers r
  left join public.router_credentials c on c.router_id = r.id
  where r.tenant_id = v_agent.tenant_id and r.connector_agent_id = v_agent.id and r.monitoring_enabled;

  -- Hand out queued commands once; the watchdog re-queues any that get no answer.
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
    'routers', v_routers,
    'commands', v_commands,
    'server_time', now()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- connector_ingest: telemetry from the agent
-- -----------------------------------------------------------------------------
create or replace function public.connector_ingest(p_token text, p_nonce text, p_ts timestamptz, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.connector_agents;
  v_simulated boolean := coalesce((p_payload ->> 'simulated')::boolean, false);
  v_src public.data_source := case when coalesce((p_payload ->> 'simulated')::boolean, false) then 'simulated'::public.data_source else 'connector'::public.data_source end;
  r jsonb;
  i jsonb;
  s jsonb;
  v_router public.routers;
  v_at timestamptz;
  v_reachable boolean;
  v_cpu numeric;
  v_mem numeric;
  v_uptime bigint;
  v_iface uuid;
  v_rx bigint;
  v_tx bigint;
  v_type public.session_type;
  v_user text;
  v_sess uuid;
  v_customer uuid;
  v_active int;
  v_accepted int := 0;
  v_rejected jsonb := '[]'::jsonb;
begin
  v_agent := private.authenticate_connector(p_token, p_nonce, p_ts);
  if jsonb_typeof(p_payload -> 'routers') <> 'array' or jsonb_array_length(p_payload -> 'routers') > 200 then
    raise exception 'Payload must list at most 200 routers.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Connector telemetry');
  update public.connector_agents set status = 'active', last_seen_at = now() where id = v_agent.id;

  for r in select value from jsonb_array_elements(p_payload -> 'routers') loop
    select * into v_router from public.routers
    where id::text = r ->> 'router_id'
      and tenant_id = v_agent.tenant_id and connector_agent_id = v_agent.id
    for update;
    if v_router.id is null then
      v_rejected := v_rejected || jsonb_build_object('router_id', r ->> 'router_id', 'reason', 'Router is not assigned to this connector.');
      continue;
    end if;
    if (v_router.data_source = 'simulated') <> v_simulated then
      v_rejected := v_rejected || jsonb_build_object('router_id', v_router.id, 'reason',
        case when v_simulated then 'Simulated data is refused for a real router.' else 'This router is a simulated test device.' end);
      continue;
    end if;

    -- The connector could not try (for example no credentials): not an outage.
    if coalesce((r ->> 'skipped')::boolean, false) then
      update public.routers set status = 'unknown', last_sync_error = left(coalesce(nullif(r ->> 'error', ''), 'Not polled'), 300)
      where id = v_router.id;
      v_accepted := v_accepted + 1;
      continue;
    end if;

    v_at := coalesce(nullif(r ->> 'collected_at', '')::timestamptz, now());
    if v_at > now() + interval '2 minutes' or v_at < now() - interval '1 day' then
      v_rejected := v_rejected || jsonb_build_object('router_id', v_router.id, 'reason', 'Reading time is outside the accepted window.');
      continue;
    end if;
    v_reachable := coalesce((r ->> 'reachable')::boolean, false);
    v_accepted := v_accepted + 1;

    insert into public.network_metrics (tenant_id, router_id, metric, value, recorded_at, data_source)
    values (v_router.tenant_id, v_router.id, 'reachable', case when v_reachable then 1 else 0 end, v_at, v_src);

    if not v_reachable then
      update public.routers
      set status = 'offline', consecutive_failures = consecutive_failures + 1,
          last_sync_error = left(coalesce(nullif(r ->> 'error', ''), 'No response'), 300)
      where id = v_router.id;
      if v_router.consecutive_failures + 1 >= 2 then
        perform private.raise_alert(v_router.tenant_id, v_router.id, 'router_offline:' || v_router.id, 'router_offline', 'critical',
          v_router.name || ' is not responding',
          'The connector could not reach the router: ' || left(coalesce(nullif(r ->> 'error', ''), 'no response'), 200), v_src);
      end if;
      continue;
    end if;

    v_cpu := least(greatest(private.try_numeric(r #>> '{system,cpu_load_pct}'), 0), 100);
    v_mem := least(greatest(private.try_numeric(r #>> '{system,memory_used_pct}'), 0), 100);
    v_uptime := greatest(private.try_numeric(r #>> '{system,uptime_seconds}'), 0)::bigint;

    update public.routers
    set status = 'online', consecutive_failures = 0, last_synced_at = v_at, last_sync_error = null,
        cpu_load_pct = v_cpu, memory_used_pct = v_mem, uptime_seconds = v_uptime,
        identity = coalesce(left(nullif(r #>> '{system,identity}', ''), 80), identity),
        model = coalesce(left(nullif(r #>> '{system,model}', ''), 80), model),
        serial_number = coalesce(left(nullif(r #>> '{system,serial_number}', ''), 40), serial_number),
        routeros_version = coalesce(left(nullif(r #>> '{system,version}', ''), 40), routeros_version)
    where id = v_router.id;
    perform private.clear_alert(v_router.tenant_id, 'router_offline:' || v_router.id, 'Router answered again at ' || to_char(v_at at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') || '.');

    insert into public.network_metrics (tenant_id, router_id, metric, value, recorded_at, data_source)
    select v_router.tenant_id, v_router.id, m.k, m.v, v_at, v_src
    from (values ('cpu_load_pct', v_cpu), ('memory_used_pct', v_mem), ('uptime_seconds', v_uptime::numeric)) as m(k, v)
    where m.v is not null;

    if v_cpu >= 90 then
      perform private.raise_alert(v_router.tenant_id, v_router.id, 'high_cpu:' || v_router.id, 'high_cpu', 'warning',
        v_router.name || ' CPU at ' || round(v_cpu) || '%', 'Sustained high CPU can drop customer sessions.', v_src);
    elsif v_cpu < 80 then
      perform private.clear_alert(v_router.tenant_id, 'high_cpu:' || v_router.id, 'CPU back to ' || round(v_cpu) || '%.');
    end if;
    if v_mem >= 90 then
      perform private.raise_alert(v_router.tenant_id, v_router.id, 'high_memory:' || v_router.id, 'high_memory', 'warning',
        v_router.name || ' memory at ' || round(v_mem) || '%', null, v_src);
    elsif v_mem < 80 then
      perform private.clear_alert(v_router.tenant_id, 'high_memory:' || v_router.id, 'Memory back to ' || round(v_mem) || '%.');
    end if;

    -- Interfaces (at most 128 per router).
    if jsonb_typeof(r -> 'interfaces') = 'array' then
      for i in select value from jsonb_array_elements(r -> 'interfaces') limit 128 loop
        continue when coalesce(trim(i ->> 'name'), '') = '';
        v_rx := greatest(private.try_numeric(i ->> 'rx_bps'), 0)::bigint;
        v_tx := greatest(private.try_numeric(i ->> 'tx_bps'), 0)::bigint;
        insert into public.router_interfaces (tenant_id, router_id, name, interface_type, mac_address, running, disabled, rx_bps, tx_bps, last_seen_at, data_source)
        values (v_router.tenant_id, v_router.id, left(i ->> 'name', 64), left(i ->> 'type', 40), private.try_macaddr(i ->> 'mac_address'),
                (i ->> 'running')::boolean, (i ->> 'disabled')::boolean, v_rx, v_tx, v_at, v_src)
        on conflict (router_id, name) do update
        set interface_type = excluded.interface_type, mac_address = excluded.mac_address, running = excluded.running,
            disabled = excluded.disabled, rx_bps = excluded.rx_bps, tx_bps = excluded.tx_bps, last_seen_at = excluded.last_seen_at,
            data_source = excluded.data_source
        returning id into v_iface;
        if v_rx is not null or v_tx is not null then
          insert into public.network_metrics (tenant_id, router_id, interface_id, metric, value, recorded_at, data_source)
          select v_router.tenant_id, v_router.id, v_iface, m.k, m.v, v_at, v_src
          from (values ('rx_bps', v_rx::numeric), ('tx_bps', v_tx::numeric)) as m(k, v) where m.v is not null;
        end if;
      end loop;
    end if;

    -- Active sessions: only when the agent could read them.
    if jsonb_typeof(r -> 'sessions') = 'array' then
      for s in select value from jsonb_array_elements(r -> 'sessions') limit 10000 loop
        v_user := left(trim(s ->> 'username'), 128);
        continue when coalesce(v_user, '') = '' or coalesce(s ->> 'type', '') not in ('pppoe', 'hotspot');
        v_type := (s ->> 'type')::public.session_type;
        select id into v_sess from public.network_sessions
        where router_id = v_router.id and session_type = v_type and username = v_user and ended_at is null
        limit 1;
        if v_sess is not null then
          update public.network_sessions
          set last_seen_at = v_at, ip_address = coalesce(private.try_inet(s ->> 'address'), ip_address),
              bytes_in = coalesce(greatest(private.try_numeric(s ->> 'bytes_in'), 0)::bigint, bytes_in),
              bytes_out = coalesce(greatest(private.try_numeric(s ->> 'bytes_out'), 0)::bigint, bytes_out)
          where id = v_sess;
        else
          select c.id into v_customer from public.customers c
          where c.tenant_id = v_router.tenant_id and lower(c.pppoe_username) = lower(v_user)
          limit 1;
          insert into public.network_sessions (tenant_id, router_id, customer_id, session_type, username, ip_address, caller_id,
                                               started_at, last_seen_at, bytes_in, bytes_out, data_source)
          values (v_router.tenant_id, v_router.id, v_customer, v_type, v_user, private.try_inet(s ->> 'address'), left(s ->> 'caller_id', 64),
                  v_at - make_interval(secs => least(coalesce(greatest(private.try_numeric(s ->> 'uptime_seconds'), 0), 0), 31536000)),
                  v_at,
                  coalesce(greatest(private.try_numeric(s ->> 'bytes_in'), 0)::bigint, 0),
                  coalesce(greatest(private.try_numeric(s ->> 'bytes_out'), 0)::bigint, 0), v_src);
          -- Learn which router holds a PPPoE customer's secret.
          if v_customer is not null and v_type = 'pppoe' then
            update public.customers set router_id = v_router.id where id = v_customer and router_id is null;
          end if;
        end if;
      end loop;
      update public.network_sessions set ended_at = greatest(v_at, started_at)
      where router_id = v_router.id and ended_at is null and last_seen_at < v_at;
      select count(*) into v_active from public.network_sessions where router_id = v_router.id and ended_at is null;
      insert into public.network_metrics (tenant_id, router_id, metric, value, recorded_at, data_source)
      values (v_router.tenant_id, v_router.id, 'active_sessions', v_active, v_at, v_src);
    end if;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'rejected', v_rejected);
end;
$$;

-- -----------------------------------------------------------------------------
-- connector_command_result
-- -----------------------------------------------------------------------------
create or replace function public.connector_command_result(
  p_token text, p_nonce text, p_ts timestamptz, p_command uuid, p_success boolean, p_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.connector_agents;
  v_cmd public.router_commands;
  v_customer text;
begin
  v_agent := private.authenticate_connector(p_token, p_nonce, p_ts);
  select rc.* into v_cmd from public.router_commands rc
  join public.routers r on r.id = rc.router_id
  where rc.id = p_command and r.connector_agent_id = v_agent.id and rc.tenant_id = v_agent.tenant_id
  for update of rc;
  if v_cmd.id is null then
    raise exception 'Command not found for this connector.' using errcode = 'no_data_found';
  end if;
  if v_cmd.status <> 'sent' then
    return; -- already answered, cancelled or expired: ignore duplicates
  end if;
  perform private.set_audit_reason('Connector command result');
  update public.router_commands
  set status = case when p_success then 'succeeded'::public.router_command_status else 'failed'::public.router_command_status end,
      completed_at = now(), result_message = left(p_message, 300)
  where id = v_cmd.id;
  if not p_success then
    select full_name into v_customer from public.customers where id = v_cmd.customer_id;
    perform private.raise_alert(v_cmd.tenant_id, v_cmd.router_id, 'command_failed:' || v_cmd.id, 'command_failed', 'warning',
      'Could not ' || case when v_cmd.command_type = 'disconnect_pppoe' then 'disconnect ' else 'reconnect ' end || coalesce(v_customer, 'a customer'),
      left(coalesce(p_message, 'The router refused the command.'), 300), 'connector');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Suspend / restore -> router commands
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
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'suspended' then
    v_type := 'disconnect_pppoe';
  elsif new.status = 'active' then
    v_type := 'reconnect_pppoe';
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
          case when v_type = 'disconnect_pppoe' then new.suspension_reason else 'Subscription active again' end,
          v_msg, auth.uid(), null);
  return new;
end;
$$;

create trigger subscriptions_router_command
  after insert or update of status on public.subscriptions
  for each row execute function private.queue_router_command();

create or replace function public.retry_router_command(p_command uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cmd public.router_commands;
  v_customer public.customers;
begin
  select * into v_cmd from public.router_commands where id = p_command for update;
  perform private.require_permission(v_cmd.tenant_id, 'subscriptions:suspend');
  if v_cmd.status not in ('failed', 'blocked', 'expired') then
    raise exception 'Only a failed, blocked or expired command can be retried.' using errcode = 'check_violation';
  end if;
  select * into v_customer from public.customers where id = v_cmd.customer_id;
  if coalesce(v_customer.pppoe_username, '') = '' or v_customer.router_id is null then
    raise exception 'Set the customer''s PPPoE username and router first.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Router command retried');
  update public.router_commands
  set status = 'queued', router_id = v_customer.router_id, pppoe_username = v_customer.pppoe_username,
      result_message = null, completed_at = null, sent_at = null
  where id = p_command;
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff functions
-- -----------------------------------------------------------------------------
create or replace function public.set_router_credentials(p_router uuid, p_username text, p_ciphertext text, p_key_version integer default 1)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_router public.routers;
begin
  select * into v_router from public.routers where id = p_router;
  perform private.require_permission(v_router.tenant_id, 'network:credentials');
  if coalesce(char_length(trim(p_username)), 0) not between 1 and 64 then
    raise exception 'Enter the router API username.' using errcode = 'check_violation';
  end if;
  if p_ciphertext !~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' then
    raise exception 'Credentials must be encrypted before they are stored.' using errcode = 'check_violation';
  end if;
  insert into public.router_credentials (router_id, tenant_id, username, secret_ciphertext, key_version, updated_by, updated_at)
  values (p_router, v_router.tenant_id, trim(p_username), p_ciphertext, p_key_version, auth.uid(), now())
  on conflict (router_id) do update
  set username = excluded.username, secret_ciphertext = excluded.secret_ciphertext, key_version = excluded.key_version,
      updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- Whether credentials are set, without revealing them.
create or replace function public.router_credential_status(p_tenant uuid)
returns table (router_id uuid, username text, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.router_id, c.username, c.updated_at
  from public.router_credentials c
  where c.tenant_id = p_tenant and private.has_permission(p_tenant, 'network:view')
$$;

create or replace function public.assign_customer_router(p_customer uuid, p_router uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
begin
  select * into v_customer from public.customers where id = p_customer;
  perform private.require_permission(v_customer.tenant_id, 'network:edit');
  if p_router is not null and not exists (select 1 from public.routers where id = p_router and tenant_id = v_customer.tenant_id) then
    raise exception 'Router not found.' using errcode = 'foreign_key_violation';
  end if;
  perform private.set_audit_reason('Customer router set');
  update public.customers set router_id = p_router where id = p_customer;
end;
$$;

create or replace function public.set_router_enforcement(p_tenant uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission(p_tenant, 'settings:manage');
  perform private.set_audit_reason(case when p_enabled then 'Router enforcement turned on' else 'Router enforcement turned off' end);
  update public.tenants set settings = settings || jsonb_build_object('router_enforcement', p_enabled) where id = p_tenant;
end;
$$;

create or replace function public.update_alert(p_alert uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert public.network_alerts;
begin
  select * into v_alert from public.network_alerts where id = p_alert for update;
  perform private.require_permission(v_alert.tenant_id, 'alerts:manage');
  if p_action not in ('acknowledge', 'resolve') then
    raise exception 'Unknown action.' using errcode = 'check_violation';
  end if;
  if v_alert.status = 'resolved' then
    raise exception 'This alert is already resolved.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(coalesce(nullif(trim(p_note), ''), 'Alert ' || p_action || 'd'));
  if p_action = 'acknowledge' then
    update public.network_alerts set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = auth.uid(),
      message = case when nullif(trim(p_note), '') is null then message else left(coalesce(message || ' ', '') || 'Note: ' || trim(p_note), 500) end
    where id = p_alert;
  else
    update public.network_alerts set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(),
      acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, auth.uid()),
      message = case when nullif(trim(p_note), '') is null then message else left(coalesce(message || ' ', '') || 'Resolution: ' || trim(p_note), 500) end
    where id = p_alert;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Watchdog: stale connectors, unanswered commands, retention. Runs at most
-- once a minute per ISP; called when network pages load (and by a scheduled
-- worker once one exists).
-- -----------------------------------------------------------------------------
create or replace function public.network_watchdog(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.connector_agents;
begin
  if not private.is_member(p_tenant) then
    raise exception 'You do not have permission to do that.' using errcode = 'insufficient_privilege';
  end if;
  insert into private.watchdog_runs (tenant_id, ran_at) values (p_tenant, now())
  on conflict (tenant_id) do update set ran_at = excluded.ran_at
  where private.watchdog_runs.ran_at < now() - interval '1 minute';
  if not found then
    return;
  end if;
  perform private.set_audit_reason('Network watchdog');

  for a in select * from public.connector_agents
           where tenant_id = p_tenant and status = 'active' and last_seen_at < now() - interval '3 minutes' loop
    update public.routers set status = 'unknown'
    where connector_agent_id = a.id and status <> 'unknown';
    perform private.raise_alert(p_tenant, null, 'connector_offline:' || a.id, 'connector_offline', 'warning',
      'Connector "' || a.name || '" has stopped reporting',
      'Last heard from ' || to_char(a.last_seen_at at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') ||
      '. Router status is unknown until it reports again; check the connector machine and its internet link.', 'connector');
  end loop;

  update public.router_commands
  set status = case when attempts >= 3 then 'failed'::public.router_command_status else 'queued'::public.router_command_status end,
      result_message = case when attempts >= 3 then 'No answer from the connector after 3 attempts.' else result_message end,
      completed_at = case when attempts >= 3 then now() else completed_at end
  where tenant_id = p_tenant and status = 'sent' and sent_at < now() - interval '10 minutes';

  update public.router_commands
  set status = 'expired', completed_at = now(), result_message = 'Not picked up by a connector within 24 hours.'
  where tenant_id = p_tenant and status = 'queued' and created_at < now() - interval '24 hours';

  -- Retention (see docs/SECURITY_GUIDE.md): metrics 90 days, ended sessions 12 months.
  delete from public.network_metrics where tenant_id = p_tenant and recorded_at < now() - interval '90 days';
  delete from public.network_sessions where tenant_id = p_tenant and ended_at < now() - interval '365 days';
  delete from private.connector_nonces n using public.connector_agents ca
  where n.agent_id = ca.id and ca.tenant_id = p_tenant and n.seen_at < now() - interval '1 hour';
end;
$$;

-- -----------------------------------------------------------------------------
-- Read helpers for the NOC
-- -----------------------------------------------------------------------------
-- Bandwidth across all routers (sum of interface rx/tx), in buckets.
create or replace function public.network_traffic(p_tenant uuid, p_hours integer default 24, p_router uuid default null)
returns table (bucket timestamptz, rx_bps numeric, tx_bps numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with b as (
    select date_bin(case when p_hours <= 24 then interval '15 minutes' else interval '1 hour' end, m.recorded_at, timestamptz '2000-01-01') as bucket,
           m.metric, m.router_id, m.interface_id, avg(m.value) as v
    from public.network_metrics m
    join public.router_interfaces i on i.id = m.interface_id
    where m.tenant_id = p_tenant and m.metric in ('rx_bps', 'tx_bps')
      and m.recorded_at >= now() - make_interval(hours => least(greatest(p_hours, 1), 720))
      and (p_router is null or m.router_id = p_router)
      and i.interface_type is distinct from 'pppoe-in'
    group by 1, 2, 3, 4
  )
  select bucket, sum(v) filter (where metric = 'rx_bps'), sum(v) filter (where metric = 'tx_bps')
  from b group by bucket order by bucket
$$;

create or replace function public.router_history(p_router uuid, p_hours integer default 24)
returns table (bucket timestamptz, cpu numeric, memory numeric, sessions numeric, reachable numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select date_bin(case when p_hours <= 24 then interval '15 minutes' else interval '1 hour' end, recorded_at, timestamptz '2000-01-01') as bucket,
         round(avg(value) filter (where metric = 'cpu_load_pct'), 1),
         round(avg(value) filter (where metric = 'memory_used_pct'), 1),
         round(avg(value) filter (where metric = 'active_sessions'), 0),
         round(avg(value) filter (where metric = 'reachable') * 100, 1)
  from public.network_metrics
  where router_id = p_router and interface_id is null
    and recorded_at >= now() - make_interval(hours => least(greatest(p_hours, 1), 720))
  group by 1 order by 1
$$;


-- Share of connector reads in which routers answered, split real vs simulated
-- so simulated data never passes as real availability.
create or replace function public.network_availability(p_tenant uuid, p_hours integer default 24)
returns table (data_source public.data_source, availability_pct numeric, samples bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.data_source, round(avg(m.value) * 100, 2), count(*)
  from public.network_metrics m
  where m.tenant_id = p_tenant and m.metric = 'reachable' and m.interface_id is null
    and m.recorded_at >= now() - make_interval(hours => least(greatest(p_hours, 1), 720))
  group by 1
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on function private.authenticate_connector(text, text, timestamptz) from public, anon, authenticated;
revoke all on function private.raise_alert(uuid, uuid, text, text, public.alert_severity, text, text, public.data_source) from public, anon, authenticated;
revoke all on function private.clear_alert(uuid, text, text) from public, anon, authenticated;

-- The connector has no user session: it calls these with the public key and
-- authenticates with its own token inside the function.
grant execute on function public.connector_sync(text, text, timestamptz, text) to anon, authenticated;
grant execute on function public.connector_ingest(text, text, timestamptz, jsonb) to anon, authenticated;
grant execute on function public.connector_command_result(text, text, timestamptz, uuid, boolean, text) to anon, authenticated;

revoke all on function public.set_router_credentials(uuid, text, text, integer) from public, anon;
revoke all on function public.router_credential_status(uuid) from public, anon;
revoke all on function public.assign_customer_router(uuid, uuid) from public, anon;
revoke all on function public.set_router_enforcement(uuid, boolean) from public, anon;
revoke all on function public.update_alert(uuid, text, text) from public, anon;
revoke all on function public.network_watchdog(uuid) from public, anon;
revoke all on function public.retry_router_command(uuid) from public, anon;
revoke all on function public.network_traffic(uuid, integer, uuid) from public, anon;
revoke all on function public.router_history(uuid, integer) from public, anon;
revoke all on function public.network_availability(uuid, integer) from public, anon;
grant execute on function public.set_router_credentials(uuid, text, text, integer) to authenticated;
grant execute on function public.router_credential_status(uuid) to authenticated;
grant execute on function public.assign_customer_router(uuid, uuid) to authenticated;
grant execute on function public.set_router_enforcement(uuid, boolean) to authenticated;
grant execute on function public.update_alert(uuid, text, text) to authenticated;
grant execute on function public.network_watchdog(uuid) to authenticated;
grant execute on function public.retry_router_command(uuid) to authenticated;
grant execute on function public.network_traffic(uuid, integer, uuid) to authenticated;
grant execute on function public.router_history(uuid, integer) to authenticated;
grant execute on function public.network_availability(uuid, integer) to authenticated;
