-- =============================================================================
-- Phase 5: support desk, field operations, notifications, map coverage.
--
-- Tickets and jobs keep their Phase 1 table policies (staff write them
-- directly under RLS). This migration adds the rules around those writes:
-- status bookkeeping, a permanent history of every change, notes, and the
-- notifications each change should send. Notifications pass through the
-- ISP's and each person's preferences, and email/SMS copies are queued in an
-- outbox for a delivery worker the software engineer will connect.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Notifications: de-duplication, preferences and an outbox for email/SMS.
-- -----------------------------------------------------------------------------
alter table public.notifications add column dedupe_key text;
create unique index notifications_dedupe on public.notifications (recipient_id, dedupe_key) where dedupe_key is not null;

create table public.notification_preferences (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  -- null profile = the ISP-wide setting the owner controls.
  profile_id uuid references public.profiles (id) on delete cascade,
  type       text not null check (type in (
               'subscription_expiry', 'payment_confirmation', 'payment_failure', 'router_offline',
               'network_outage', 'customer_complaint', 'installation_completion', 'critical_network_warning')),
  in_app     boolean not null default true,
  email      boolean not null default false,
  sms        boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index notification_preferences_tenant on public.notification_preferences (tenant_id, type) where profile_id is null;
create unique index notification_preferences_person on public.notification_preferences (tenant_id, profile_id, type) where profile_id is not null;
create trigger notification_preferences_updated_at before update on public.notification_preferences
  for each row execute function private.set_updated_at();
alter table public.notification_preferences enable row level security;

create policy notification_preferences_select on public.notification_preferences for select to authenticated
  using (private.is_member(tenant_id) and (profile_id is null or profile_id = auth.uid()));
create policy notification_preferences_own on public.notification_preferences for all to authenticated
  using (profile_id = auth.uid() and private.is_member(tenant_id))
  with check (profile_id = auth.uid() and private.is_member(tenant_id));
create policy notification_preferences_tenant on public.notification_preferences for all to authenticated
  using (profile_id is null and private.has_permission(tenant_id, 'settings:manage'))
  with check (profile_id is null and private.has_permission(tenant_id, 'settings:manage'));

-- Email and SMS copies wait here. No provider is connected yet.
-- TODO: SOFTWARE ENGINEER - CONNECT EMAIL AND SMS PROVIDERS (e.g. Africa's Talking for SMS)
-- and deliver pending rows from a worker using the service role.
create table public.notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  tenant_id       uuid references public.tenants (id) on delete cascade,
  recipient_id    uuid not null references public.profiles (id) on delete cascade,
  channel         public.notification_channel not null check (channel <> 'in_app'),
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (notification_id, channel)
);
alter table public.notification_outbox enable row level security;
create policy notification_outbox_select on public.notification_outbox for select to authenticated
  using (recipient_id = auth.uid());

-- Applies preferences to every notification, whichever code inserts it
-- (alerts, tickets, payments, expiry). Returning null drops a muted one.
create or replace function private.apply_notification_preferences()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.notification_preferences;
  v_person public.notification_preferences;
begin
  if new.tenant_id is null or new.type in ('staff_invitation', 'system') then
    return new;
  end if;
  select * into v_tenant from public.notification_preferences
  where tenant_id = new.tenant_id and profile_id is null and type = new.type;
  select * into v_person from public.notification_preferences
  where tenant_id = new.tenant_id and profile_id = new.recipient_id and type = new.type;
  if coalesce(v_tenant.in_app, true) = false or coalesce(v_person.in_app, true) = false then
    return null;
  end if;
  return new;
end;
$$;
create trigger notifications_preferences before insert on public.notifications
  for each row execute function private.apply_notification_preferences();

create or replace function private.queue_notification_copies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is null then
    return new;
  end if;
  insert into public.notification_outbox (notification_id, tenant_id, recipient_id, channel)
  select new.id, new.tenant_id, new.recipient_id, c.channel
  from (values ('email'::public.notification_channel), ('sms'::public.notification_channel)) as c(channel)
  join public.notification_preferences p
    on p.tenant_id = new.tenant_id and p.profile_id = new.recipient_id and p.type = new.type
  where (c.channel = 'email' and p.email) or (c.channel = 'sms' and p.sms)
  on conflict do nothing;
  return new;
end;
$$;
create trigger notifications_outbox after insert on public.notifications
  for each row execute function private.queue_notification_copies();

-- Send one notification to every active member who holds a permission.
create or replace function private.notify_permission(
  p_tenant uuid, p_permission text, p_type text, p_title text, p_body text, p_link text,
  p_dedupe text default null, p_except uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (tenant_id, recipient_id, type, title, body, link, dedupe_key)
  select p_tenant, m.profile_id, p_type, left(p_title, 160), left(p_body, 500), p_link, p_dedupe
  from public.tenant_members m
  join private.role_permissions rp on rp.role = m.role and rp.permission = p_permission
  where m.tenant_id = p_tenant and m.status = 'active' and m.profile_id is distinct from p_except
  on conflict do nothing
$$;

create or replace function private.notify_person(
  p_tenant uuid, p_profile uuid, p_type text, p_title text, p_body text, p_link text, p_dedupe text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (tenant_id, recipient_id, type, title, body, link, dedupe_key)
  select p_tenant, p_profile, p_type, left(p_title, 160), left(p_body, 500), p_link, p_dedupe
  where p_profile is not null
    and exists (select 1 from public.tenant_members m where m.tenant_id = p_tenant and m.profile_id = p_profile and m.status = 'active')
  on conflict do nothing
$$;

-- -----------------------------------------------------------------------------
-- Support tickets: status rules, history and notifications.
-- -----------------------------------------------------------------------------
create type public.ticket_event_type as enum ('created', 'status', 'assigned', 'priority', 'comment', 'job');

create table public.ticket_events (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  ticket_id  uuid not null,
  event_type public.ticket_event_type not null,
  from_value text,
  to_value   text,
  note       text check (note is null or char_length(note) <= 2000),
  actor_id   uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, ticket_id) references public.support_tickets (tenant_id, id) on delete cascade
);
create index ticket_events_ticket_idx on public.ticket_events (ticket_id, created_at);
alter table public.ticket_events enable row level security;
create policy ticket_events_select on public.ticket_events for select to authenticated
  using (private.has_permission(tenant_id, 'tickets:view')
         or exists (select 1 from public.support_tickets t where t.id = ticket_id and t.assigned_to = auth.uid() and private.is_member(t.tenant_id)));
-- No write policies: events are written by triggers and functions only.

create or replace function private.ticket_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    if not exists (select 1 from public.tenant_members m where m.tenant_id = new.tenant_id and m.profile_id = new.assigned_to and m.status = 'active') then
      raise exception 'Tickets can only be assigned to active staff of this ISP.' using errcode = 'check_violation';
    end if;
    if new.status = 'open' then
      new.status := 'assigned';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.assigned_to is null and old.assigned_to is not null and new.status = 'assigned' then
    new.status := 'open';
  end if;
  if new.status in ('resolved', 'closed') then
    if coalesce(btrim(new.resolution_notes), '') = '' then
      raise exception 'Say how the issue was resolved before resolving or closing the ticket.' using errcode = 'check_violation';
    end if;
    new.resolved_at := coalesce(new.resolved_at, now());
  else
    new.resolved_at := null;
  end if;
  new.closed_at := case when new.status = 'closed' then coalesce(new.closed_at, now()) else null end;
  return new;
end;
$$;
create trigger support_tickets_rules before insert or update on public.support_tickets
  for each row execute function private.ticket_rules();

create or replace function private.ticket_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer text;
  v_actor uuid := auth.uid();
begin
  select full_name into v_customer from public.customers where id = new.customer_id;
  if tg_op = 'INSERT' then
    insert into public.ticket_events (tenant_id, ticket_id, event_type, to_value, actor_id)
    values (new.tenant_id, new.id, 'created', new.status::text, v_actor);
    perform private.notify_permission(
      new.tenant_id, 'tickets:edit', 'customer_complaint',
      new.ticket_number || ': ' || new.subject,
      coalesce(v_customer || ' · ', '') || replace(new.category::text, '_', ' ') || ', ' || new.priority::text || ' priority',
      '/support/' || new.id, 'ticket-new:' || new.id, v_actor);
    if new.assigned_to is not null then
      insert into public.ticket_events (tenant_id, ticket_id, event_type, to_value, actor_id)
      values (new.tenant_id, new.id, 'assigned', new.assigned_to::text, v_actor);
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.ticket_events (tenant_id, ticket_id, event_type, from_value, to_value, note, actor_id)
    values (new.tenant_id, new.id, 'status', old.status::text, new.status::text,
            case when new.status in ('resolved', 'closed') and new.resolution_notes is distinct from old.resolution_notes then new.resolution_notes end,
            v_actor);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.ticket_events (tenant_id, ticket_id, event_type, from_value, to_value, actor_id)
    values (new.tenant_id, new.id, 'assigned', old.assigned_to::text, new.assigned_to::text, v_actor);
    if new.assigned_to is distinct from v_actor then
      perform private.notify_person(new.tenant_id, new.assigned_to, 'customer_complaint',
        'Assigned to you: ' || new.ticket_number, new.subject, '/support/' || new.id,
        'ticket-assign:' || new.id || ':' || new.assigned_to || ':' || extract(epoch from now())::bigint);
    end if;
  end if;
  if new.priority is distinct from old.priority then
    insert into public.ticket_events (tenant_id, ticket_id, event_type, from_value, to_value, actor_id)
    values (new.tenant_id, new.id, 'priority', old.priority::text, new.priority::text, v_actor);
  end if;
  return new;
end;
$$;
create trigger support_tickets_history after insert or update on public.support_tickets
  for each row execute function private.ticket_history();

create trigger support_tickets_audit after insert or update or delete on public.support_tickets
  for each row execute function private.audit_row_change();

-- A comment on a ticket: staff who can edit tickets, or the assignee.
create or replace function public.add_ticket_comment(p_ticket uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.support_tickets;
  v_id uuid;
begin
  select * into t from public.support_tickets where id = p_ticket;
  if not found or not (private.has_permission(t.tenant_id, 'tickets:edit') or (t.assigned_to = auth.uid() and private.is_member(t.tenant_id))) then
    raise exception 'Ticket not found or you cannot change it.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_note), '') = '' or char_length(p_note) > 2000 then
    raise exception 'Write a note of up to 2,000 characters.' using errcode = 'check_violation';
  end if;
  insert into public.ticket_events (tenant_id, ticket_id, event_type, note, actor_id)
  values (t.tenant_id, t.id, 'comment', btrim(p_note), auth.uid())
  returning id into v_id;
  update public.support_tickets set updated_at = now() where id = t.id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Field jobs: status rules, history, notes and notifications.
-- -----------------------------------------------------------------------------
create table public.job_events (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  job_id     uuid not null,
  event_type text not null check (event_type in ('created', 'status', 'assigned', 'scheduled', 'note')),
  from_value text,
  to_value   text,
  note       text check (note is null or char_length(note) <= 2000),
  actor_id   uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, job_id) references public.installation_jobs (tenant_id, id) on delete cascade
);
create index job_events_job_idx on public.job_events (job_id, created_at);
alter table public.job_events enable row level security;
create policy job_events_select on public.job_events for select to authenticated
  using (private.has_permission(tenant_id, 'jobs:view')
         or exists (select 1 from public.installation_jobs j where j.id = job_id and j.technician_id = private.my_technician_id(j.tenant_id)));

create or replace function private.job_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status in ('completed', 'cancelled') and new.status is distinct from old.status
     and not private.has_permission(new.tenant_id, 'jobs:edit') and auth.role() = 'authenticated' then
    raise exception 'This job is closed. Ask a supervisor to reopen it.' using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'in_progress' then
    new.started_at := coalesce(new.started_at, now());
  end if;
  if new.status = 'completed' then
    if coalesce(btrim(new.completion_notes), '') = '' then
      raise exception 'Record what was done before completing the job.' using errcode = 'check_violation';
    end if;
    new.started_at := coalesce(new.started_at, now());
    new.completed_at := coalesce(new.completed_at, now());
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;
create trigger installation_jobs_rules before insert or update on public.installation_jobs
  for each row execute function private.job_rules();

create or replace function private.job_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_tech_profile uuid;
  v_customer text;
  v_label text;
begin
  select profile_id into v_tech_profile from public.technicians where id = new.technician_id;
  select full_name into v_customer from public.customers where id = new.customer_id;
  v_label := initcap(replace(new.job_type::text, '_', ' '));

  if tg_op = 'INSERT' then
    insert into public.job_events (tenant_id, job_id, event_type, to_value, actor_id)
    values (new.tenant_id, new.id, 'created', new.status::text, v_actor);
    if new.ticket_id is not null then
      insert into public.ticket_events (tenant_id, ticket_id, event_type, to_value, note, actor_id)
      values (new.tenant_id, new.ticket_id, 'job', new.job_number, v_label || ' job created', v_actor);
    end if;
  else
    if new.status is distinct from old.status then
      insert into public.job_events (tenant_id, job_id, event_type, from_value, to_value, note, actor_id)
      values (new.tenant_id, new.id, 'status', old.status::text, new.status::text,
              case when new.status = 'completed' then new.completion_notes end, v_actor);
    end if;
    if new.scheduled_for is distinct from old.scheduled_for then
      insert into public.job_events (tenant_id, job_id, event_type, from_value, to_value, actor_id)
      values (new.tenant_id, new.id, 'scheduled', old.scheduled_for::text, new.scheduled_for::text, v_actor);
    end if;
  end if;

  if new.technician_id is not null and (tg_op = 'INSERT' or new.technician_id is distinct from old.technician_id) then
    insert into public.job_events (tenant_id, job_id, event_type, from_value, to_value, actor_id)
    values (new.tenant_id, new.id, 'assigned', case when tg_op = 'UPDATE' then old.technician_id::text end, new.technician_id::text, v_actor);
    if v_tech_profile is distinct from v_actor then
      perform private.notify_person(new.tenant_id, v_tech_profile, 'customer_complaint',
        'New job: ' || new.job_number || ' · ' || v_label,
        coalesce(v_customer, 'No customer') || coalesce(' · ' || to_char(new.scheduled_for at time zone 'Africa/Nairobi', 'DD Mon HH24:MI'), ''),
        '/field-operations/' || new.id, 'job-assign:' || new.id || ':' || new.technician_id);
    end if;
  end if;

  if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
    perform private.notify_permission(new.tenant_id, 'jobs:edit', 'installation_completion',
      v_label || ' completed: ' || new.job_number,
      coalesce(v_customer || ' · ', '') || left(coalesce(new.completion_notes, ''), 200),
      '/field-operations/' || new.id, 'job-done:' || new.id, v_actor);
    -- Record the completion on the linked ticket so support can follow up and resolve it.
    if new.ticket_id is not null then
      insert into public.ticket_events (tenant_id, ticket_id, event_type, to_value, note, actor_id)
      values (new.tenant_id, new.ticket_id, 'job', new.job_number, 'Job completed: ' || left(coalesce(new.completion_notes, ''), 300), v_actor);
    end if;
  end if;
  return new;
end;
$$;
create trigger installation_jobs_history after insert or update on public.installation_jobs
  for each row execute function private.job_history();

create trigger installation_jobs_audit after insert or update or delete on public.installation_jobs
  for each row execute function private.audit_row_change();

create or replace function public.add_job_note(p_job uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.installation_jobs;
  v_id uuid;
begin
  select * into j from public.installation_jobs where id = p_job;
  if not found or not (private.has_permission(j.tenant_id, 'jobs:edit')
     or (private.has_permission(j.tenant_id, 'jobs:update_own') and j.technician_id = private.my_technician_id(j.tenant_id))) then
    raise exception 'Job not found or you cannot change it.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_note), '') = '' or char_length(p_note) > 2000 then
    raise exception 'Write a note of up to 2,000 characters.' using errcode = 'check_violation';
  end if;
  insert into public.job_events (tenant_id, job_id, event_type, note, actor_id)
  values (j.tenant_id, j.id, 'note', btrim(p_note), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Staff with the technician role get a technician record automatically.
create or replace function private.sync_technician()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'technician' and new.status = 'active' then
    insert into public.technicians (tenant_id, profile_id) values (new.tenant_id, new.profile_id)
    on conflict (tenant_id, profile_id) do update set active = true;
  else
    update public.technicians set active = false
    where tenant_id = new.tenant_id and profile_id = new.profile_id and active
      and new.role <> 'technician';
    if new.status <> 'active' then
      update public.technicians set active = false where tenant_id = new.tenant_id and profile_id = new.profile_id;
    end if;
  end if;
  return new;
end;
$$;
create trigger tenant_members_technician after insert or update of role, status on public.tenant_members
  for each row execute function private.sync_technician();

insert into public.technicians (tenant_id, profile_id)
select m.tenant_id, m.profile_id from public.tenant_members m
where m.role = 'technician' and m.status = 'active'
on conflict (tenant_id, profile_id) do nothing;

-- Staff who can see jobs need names of the technicians' profiles; a small
-- view keeps profile emails private.
create or replace function public.technician_directory(p_tenant uuid)
returns table (technician_id uuid, profile_id uuid, full_name text, zone text, phone text, open_jobs bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.profile_id, coalesce(p.full_name, 'Technician'), t.zone, t.phone,
         (select count(*) from public.installation_jobs j where j.technician_id = t.id and j.status in ('scheduled', 'in_progress', 'on_hold'))
  from public.technicians t
  join public.profiles p on p.id = t.profile_id
  where t.tenant_id = p_tenant and t.active
    and (private.has_permission(p_tenant, 'jobs:view') or private.has_permission(p_tenant, 'tickets:edit'))
  order by 3
$$;

-- People a ticket can be assigned to (active staff), names only.
create or replace function public.staff_directory(p_tenant uuid)
returns table (profile_id uuid, full_name text, role public.tenant_role)
language sql
stable
security definer
set search_path = ''
as $$
  select m.profile_id, coalesce(p.full_name, 'Staff member'), m.role
  from public.tenant_members m
  join public.profiles p on p.id = m.profile_id
  where m.tenant_id = p_tenant and m.status = 'active' and private.is_member(p_tenant)
  order by 2
$$;

-- -----------------------------------------------------------------------------
-- Payment and expiry notifications.
-- -----------------------------------------------------------------------------
create or replace function private.payment_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer text;
  v_what text;
begin
  if new.data_source = 'simulated' then
    return new;
  end if;
  select full_name into v_customer from public.customers where id = new.customer_id;
  v_what := 'Ksh ' || to_char(new.amount, 'FM999,999,990.00') || coalesce(' from ' || v_customer, '') || coalesce(' · ' || new.provider_reference, '');
  if new.verification_status = 'verified' and old.verification_status is distinct from 'verified' then
    perform private.notify_permission(new.tenant_id, 'payments:view', 'payment_confirmation',
      'Payment confirmed', v_what, '/payments/' || new.id, 'pay-ok:' || new.id, auth.uid());
  elsif (new.verification_status = 'rejected' and old.verification_status is distinct from 'rejected')
     or (new.status in ('failed', 'reversed') and old.status is distinct from new.status) then
    perform private.notify_permission(new.tenant_id, 'payments:view', 'payment_failure',
      case when new.status = 'reversed' then 'Payment reversed' when new.status = 'failed' then 'Payment failed' else 'Payment rejected' end,
      v_what, '/payments/' || new.id, 'pay-bad:' || new.id || ':' || new.status || ':' || new.verification_status, auth.uid());
  end if;
  return new;
end;
$$;
create trigger payments_notifications after update of status, verification_status on public.payments
  for each row execute function private.payment_notifications();

-- Warn about packages ending in the next 3 days, once per subscription period.
create or replace function public.notify_expiring_subscriptions(p_tenant uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  r record;
begin
  if not (private.is_member(p_tenant) or auth.role() = 'service_role') then
    raise exception 'You do not have permission to do that.' using errcode = 'insufficient_privilege';
  end if;
  for r in
    select s.id, s.expires_at, c.full_name, c.id as customer_id, p.name as package
    from public.subscriptions s
    join public.customers c on c.id = s.customer_id
    join public.service_packages p on p.id = s.package_id
    where s.tenant_id = p_tenant and s.status = 'active'
      and s.expires_at > now() and s.expires_at <= now() + interval '3 days'
      and c.data_source <> 'simulated'
  loop
    perform private.notify_permission(p_tenant, 'subscriptions:edit', 'subscription_expiry',
      r.full_name || '''s package ends soon',
      r.package || ' ends ' || to_char(r.expires_at at time zone 'Africa/Nairobi', 'DD Mon YYYY, HH24:MI'),
      '/customers/' || r.customer_id, 'expiry:' || r.id || ':' || r.expires_at::date);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Network outage: two or more routers offline at once is an outage, not a
-- single device problem. Raised from the router offline alert.
create or replace function private.outage_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offline integer;
begin
  if new.alert_type = 'router_offline' and new.status = 'open' and new.data_source <> 'simulated' then
    select count(*) into v_offline from public.routers
    where tenant_id = new.tenant_id and status = 'offline' and data_source <> 'simulated';
    if v_offline >= 2 then
      perform private.notify_permission(new.tenant_id, 'alerts:view', 'network_outage',
        'Network outage: ' || v_offline || ' routers offline',
        'Several routers stopped answering at the same time. Check power and uplinks.',
        '/network-map', 'outage:' || new.tenant_id || ':' || date_trunc('hour', now()));
    end if;
  end if;
  return new;
end;
$$;
create trigger network_alerts_outage after insert on public.network_alerts
  for each row execute function private.outage_check();

-- -----------------------------------------------------------------------------
-- Map: optional coverage radius per router.
-- -----------------------------------------------------------------------------
alter table public.routers add column coverage_radius_m integer check (coverage_radius_m is null or coverage_radius_m between 50 and 50000);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on function private.apply_notification_preferences() from public, anon, authenticated;
revoke all on function private.queue_notification_copies() from public, anon, authenticated;
revoke all on function private.notify_permission(uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function private.notify_person(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.add_ticket_comment(uuid, text) from public, anon;
revoke all on function public.add_job_note(uuid, text) from public, anon;
revoke all on function public.technician_directory(uuid) from public, anon;
revoke all on function public.staff_directory(uuid) from public, anon;
revoke all on function public.notify_expiring_subscriptions(uuid) from public, anon;
grant execute on function public.add_ticket_comment(uuid, text) to authenticated;
grant execute on function public.add_job_note(uuid, text) to authenticated;
grant execute on function public.technician_directory(uuid) to authenticated;
grant execute on function public.staff_directory(uuid) to authenticated;
grant execute on function public.notify_expiring_subscriptions(uuid) to authenticated, service_role;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select on public.ticket_events, public.job_events, public.notification_outbox to authenticated;

-- -----------------------------------------------------------------------------
-- Router report for business intelligence (RLS applies: network:view).
-- -----------------------------------------------------------------------------
create or replace function public.router_report(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns table (
  router_id uuid, name text, data_source public.data_source, status public.device_status,
  availability_pct numeric, samples bigint, avg_cpu numeric, max_cpu numeric, avg_memory numeric, max_memory numeric,
  peak_sessions numeric, offline_alerts bigint, warnings bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id, r.name, r.data_source, r.status,
         round(avg(m.value) filter (where m.metric = 'reachable') * 100, 2),
         count(*) filter (where m.metric = 'reachable'),
         round(avg(m.value) filter (where m.metric = 'cpu_load_pct'), 1),
         max(m.value) filter (where m.metric = 'cpu_load_pct'),
         round(avg(m.value) filter (where m.metric = 'memory_used_pct'), 1),
         max(m.value) filter (where m.metric = 'memory_used_pct'),
         max(m.value) filter (where m.metric = 'active_sessions'),
         (select count(*) from public.network_alerts a where a.router_id = r.id and a.alert_type = 'router_offline' and a.opened_at >= p_from and a.opened_at < p_to),
         (select count(*) from public.network_alerts a where a.router_id = r.id and a.severity = 'warning' and a.opened_at >= p_from and a.opened_at < p_to)
  from public.routers r
  left join public.network_metrics m
    on m.router_id = r.id and m.interface_id is null and m.recorded_at >= p_from and m.recorded_at < p_to
  where r.tenant_id = p_tenant
    and p_to > p_from and p_to - p_from <= interval '400 days'
    and private.has_permission(p_tenant, 'reports:network')
  group by r.id
  order by r.name
$$;
revoke all on function public.router_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.router_report(uuid, timestamptz, timestamptz) to authenticated;

-- =============================================================================
-- Business intelligence reports (spec Module 12)
--
-- Aggregate-only functions. Each checks the report permission itself and
-- filters by tenant, then runs as SECURITY DEFINER so a report is complete
-- for the people allowed to see it (finance sees router counts in the area
-- report, for example) without widening anyone's access to rows. Dates are
-- Kenyan calendar days (inclusive). Simulated rows are left out everywhere.
-- =============================================================================

create or replace function private.require_report(p_tenant uuid, p_permission text, p_from date, p_to date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_tenant is null or not private.has_permission(p_tenant, p_permission) then
    raise exception 'You do not have permission to view this report.' using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  return coalesce(v_tz, 'Africa/Nairobi');
end;
$$;
grant execute on function private.require_report(uuid, text, date, date) to authenticated;

-- Area of a customer, as reports show it.
create or replace function private.area_of(p_estate text, p_town text, p_county text)
returns text
language sql
immutable
set search_path = ''
as $$ select coalesce(nullif(trim(p_estate), ''), nullif(trim(p_town), ''), nullif(trim(p_county), ''), 'No area recorded') $$;
grant execute on function private.area_of(text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Customer acquisition and churn, by month. Needs reports:financial and
-- customers:view.
--   new_customers       registered in the month
--   first_subscriptions customers whose first ever package started that month
--   active_at_start     customers with a live subscription at the month start
--   lapsed              customers whose last subscription ended in the month
--                       (expired or cancelled) with nothing after it yet
--   terminated          customers moved to disconnected or terminated
--   churn_pct           lapsed / active_at_start
-- -----------------------------------------------------------------------------
create or replace function public.bi_customer_report(p_tenant uuid, p_from date, p_to date, p_area text default null)
returns table (month date, new_customers integer, first_subscriptions integer, active_at_start integer, lapsed integer, terminated integer, churn_pct numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.require_report(p_tenant, 'reports:financial', p_from, p_to);
begin
  if not private.has_permission(p_tenant, 'customers:view') then
    raise exception 'You do not have permission to view customers.' using errcode = 'insufficient_privilege';
  end if;
  return query
  with months as (
    select gs::date as mo, (gs + interval '1 month')::date as next_mo
    from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') gs
  ),
  cust as (
    select c.id, c.registered_on from public.customers c
    where c.tenant_id = p_tenant and c.data_source <> 'simulated'
      and (p_area is null or trim(p_area) = '' or lower(trim(p_area)) in (lower(coalesce(c.county, '')), lower(coalesce(c.town, '')), lower(coalesce(c.estate, ''))))
  ),
  subs as (
    select s.customer_id, s.status,
           (s.starts_at at time zone v_tz) as starts_local,
           (coalesce(s.ended_at, s.expires_at) at time zone v_tz) as ends_local
    from public.subscriptions s join cust on cust.id = s.customer_id
    where s.tenant_id = p_tenant and s.status <> 'pending'
  ),
  firsts as (select customer_id, min(starts_local) as first_start from subs group by 1),
  lasts as (
    select distinct on (customer_id) customer_id, status, ends_local
    from subs order by customer_id, ends_local desc nulls first
  ),
  status_changes as (
    select (a.created_at at time zone v_tz) as at_local
    from public.audit_logs a join cust on cust.id = a.entity_id
    where a.tenant_id = p_tenant and a.entity_type = 'customers' and a.action = 'update'
      and a.after_data ->> 'status' in ('disconnected', 'terminated')
      and coalesce(a.before_data ->> 'status', '') not in ('disconnected', 'terminated')
  ),
  m as (
    select months.mo,
      (select count(*) from cust where cust.registered_on >= months.mo and cust.registered_on < months.next_mo)::integer as new_c,
      (select count(*) from firsts f where f.first_start >= months.mo and f.first_start < months.next_mo)::integer as first_s,
      (select count(distinct s.customer_id) from subs s
        where s.starts_local <= months.mo and (s.ends_local is null or s.ends_local > months.mo))::integer as active_s,
      (select count(*) from lasts l
        where l.status in ('expired', 'cancelled') and l.ends_local >= months.mo and l.ends_local < months.next_mo
          and l.ends_local < (now() at time zone v_tz))::integer as lapsed_c,
      (select count(*) from status_changes sc where sc.at_local >= months.mo and sc.at_local < months.next_mo)::integer as term_c
    from months
  )
  select m.mo, m.new_c, m.first_s, m.active_s, m.lapsed_c, m.term_c,
         case when m.active_s > 0 then round(m.lapsed_c * 100.0 / m.active_s, 1) end
  from m order by m.mo;
end;
$$;

-- -----------------------------------------------------------------------------
-- Subscription performance by package. Needs reports:financial.
-- Counts of packages sold in the range by kind of sale, the subscriptions
-- live now, and subscriptions that lapsed in the range.
-- -----------------------------------------------------------------------------
create or replace function public.bi_subscription_report(p_tenant uuid, p_from date, p_to date, p_area text default null)
returns table (package text, price numeric, active_now integer, suspended_now integer, sold_new integer, renewals integer,
               upgrades integer, downgrades integer, restores integer, lapsed integer, sales_value numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.require_report(p_tenant, 'reports:financial', p_from, p_to);
begin
  return query
  with subs as (
    select s.*, (s.created_at at time zone v_tz)::date as sold_on,
           (coalesce(s.ended_at, s.expires_at) at time zone v_tz)::date as ended_on
    from public.subscriptions s
    join public.customers c on c.id = s.customer_id
    where s.tenant_id = p_tenant and c.data_source <> 'simulated'
      and (p_area is null or trim(p_area) = '' or lower(trim(p_area)) in (lower(coalesce(c.county, '')), lower(coalesce(c.town, '')), lower(coalesce(c.estate, ''))))
  )
  select sp.name, sp.price,
    (count(*) filter (where s.status = 'active'))::integer,
    (count(*) filter (where s.status = 'suspended'))::integer,
    (count(*) filter (where s.change_type = 'new' and s.sold_on between p_from and p_to))::integer,
    (count(*) filter (where s.change_type = 'renewal' and s.sold_on between p_from and p_to))::integer,
    (count(*) filter (where s.change_type = 'upgrade' and s.sold_on between p_from and p_to))::integer,
    (count(*) filter (where s.change_type = 'downgrade' and s.sold_on between p_from and p_to))::integer,
    (count(*) filter (where s.change_type = 'restore' and s.sold_on between p_from and p_to))::integer,
    (count(*) filter (where s.status in ('expired', 'cancelled') and s.ended_on between p_from and p_to
       and not exists (select 1 from subs n where n.previous_subscription_id = s.id)))::integer,
    coalesce(sum(s.price) filter (where s.change_type <> 'restore' and s.status <> 'pending' and s.sold_on between p_from and p_to), 0)::numeric
  from public.service_packages sp
  left join subs s on s.package_id = sp.id
  where sp.tenant_id = p_tenant
  group by sp.id, sp.name, sp.price
  having sp.status <> 'archived' or count(s.id) > 0
  order by sp.price, sp.name;
end;
$$;

-- -----------------------------------------------------------------------------
-- Payment reconciliation: every payment in the range by method and where it
-- stands (verified and matched to a statement, verified only, awaiting
-- verification, rejected, failed, reversed). Needs reports:financial.
-- -----------------------------------------------------------------------------
create or replace function public.bi_payment_report(p_tenant uuid, p_from date, p_to date)
returns table (method public.payment_method, state text, payments integer, amount numeric, unallocated numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.require_report(p_tenant, 'reports:financial', p_from, p_to);
begin
  return query
  with p as (
    select p.*,
      case
        when p.status in ('reversed', 'refunded') then 'Reversed or refunded'
        when p.status in ('failed', 'cancelled') then 'Failed or cancelled'
        when p.status = 'pending' then 'Pending at provider'
        when p.verification_status = 'rejected' then 'Rejected at verification'
        when p.verification_status = 'unverified' then 'Awaiting verification'
        when p.reconciliation_status = 'matched' then 'Verified and matched to a statement'
        when p.reconciliation_status in ('unmatched', 'disputed') then 'Verified, statement mismatch or dispute'
        else 'Verified, not yet on a statement'
      end as st,
      p.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.payment_id = p.id), 0) as left_over
    from public.payments p
    where p.tenant_id = p_tenant and p.data_source <> 'simulated'
      and (p.transaction_at at time zone v_tz)::date between p_from and p_to
  )
  select p.method, p.st, count(*)::integer, sum(p.amount)::numeric,
         coalesce(sum(p.left_over) filter (where p.status = 'successful' and p.verification_status = 'verified'), 0)::numeric
  from p group by 1, 2 order by 1, 2;
end;
$$;

-- -----------------------------------------------------------------------------
-- Support tickets and field jobs, by category / job type, plus technician
-- performance. Needs reports:support. Hours are elapsed hours from opening to
-- resolution (tickets) or completion (jobs).
-- -----------------------------------------------------------------------------
create or replace function public.bi_support_report(p_tenant uuid, p_from date, p_to date)
returns table (kind text, label text, opened integer, resolved integer, open_now integer, avg_hours numeric, median_hours numeric, within_24h_pct numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.require_report(p_tenant, 'reports:support', p_from, p_to);
begin
  return query
  with t as (
    select x.*, (x.created_at at time zone v_tz)::date as opened_on,
           (coalesce(x.resolved_at, x.closed_at) at time zone v_tz)::date as done_on,
           extract(epoch from (coalesce(x.resolved_at, x.closed_at) - x.created_at)) / 3600 as hrs
    from public.support_tickets x where x.tenant_id = p_tenant
  ),
  j as (
    select x.*, (x.created_at at time zone v_tz)::date as opened_on, (x.completed_at at time zone v_tz)::date as done_on,
           extract(epoch from (x.completed_at - x.created_at)) / 3600 as hrs,
           coalesce(pr.full_name, 'Unnamed technician') as tech
    from public.installation_jobs x
    left join public.technicians te on te.id = x.technician_id
    left join public.profiles pr on pr.id = te.profile_id
    where x.tenant_id = p_tenant
  )
  select 'ticket'::text, t.category::text,
    (count(*) filter (where t.opened_on between p_from and p_to))::integer,
    (count(*) filter (where t.done_on between p_from and p_to))::integer,
    (count(*) filter (where t.status not in ('resolved', 'closed')))::integer,
    round(avg(t.hrs) filter (where t.done_on between p_from and p_to)::numeric, 1),
    round((percentile_cont(0.5) within group (order by t.hrs) filter (where t.done_on between p_from and p_to))::numeric, 1),
    round(100.0 * count(*) filter (where t.done_on between p_from and p_to and t.hrs <= 24)
          / nullif(count(*) filter (where t.done_on between p_from and p_to), 0), 1)
  from t group by t.category
  union all
  select 'job', j.job_type::text,
    (count(*) filter (where j.opened_on between p_from and p_to))::integer,
    (count(*) filter (where j.status = 'completed' and j.done_on between p_from and p_to))::integer,
    (count(*) filter (where j.status not in ('completed', 'cancelled')))::integer,
    round(avg(j.hrs) filter (where j.status = 'completed' and j.done_on between p_from and p_to)::numeric, 1),
    round((percentile_cont(0.5) within group (order by j.hrs) filter (where j.status = 'completed' and j.done_on between p_from and p_to))::numeric, 1),
    round(100.0 * count(*) filter (where j.status = 'completed' and j.done_on between p_from and p_to and j.hrs <= 24)
          / nullif(count(*) filter (where j.status = 'completed' and j.done_on between p_from and p_to), 0), 1)
  from j group by j.job_type
  union all
  select 'technician', j.tech,
    (count(*) filter (where j.opened_on between p_from and p_to))::integer,
    (count(*) filter (where j.status = 'completed' and j.done_on between p_from and p_to))::integer,
    (count(*) filter (where j.status not in ('completed', 'cancelled')))::integer,
    round(avg(j.hrs) filter (where j.status = 'completed' and j.done_on between p_from and p_to)::numeric, 1),
    round((percentile_cont(0.5) within group (order by j.hrs) filter (where j.status = 'completed' and j.done_on between p_from and p_to))::numeric, 1),
    round(100.0 * count(*) filter (where j.status = 'completed' and j.done_on between p_from and p_to and j.hrs <= 24)
          / nullif(count(*) filter (where j.status = 'completed' and j.done_on between p_from and p_to), 0), 1)
  from j where j.technician_id is not null group by j.tech
  order by 1, 3 desc, 2;
end;
$$;

-- -----------------------------------------------------------------------------
-- Geographical performance: one row per area (estate, else town, else
-- county). Money needs revenue:view on top of reports:financial. Routers
-- are counted in every area whose customers they serve, simulated included,
-- because the routers page labels those.
-- -----------------------------------------------------------------------------
create or replace function public.bi_area_report(p_tenant uuid, p_from date, p_to date)
returns table (area text, customers integer, new_customers integer, active_subscriptions integer, collected numeric,
               outstanding numeric, tickets_opened integer, open_tickets integer, routers integer, routers_offline integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.require_report(p_tenant, 'reports:financial', p_from, p_to);
begin
  if not private.has_permission(p_tenant, 'revenue:view') then
    raise exception 'You do not have permission to view revenue.' using errcode = 'insufficient_privilege';
  end if;
  return query
  with c as (
    select cu.id, cu.registered_on, cu.status, cu.router_id, private.area_of(cu.estate, cu.town, cu.county) as ar
    from public.customers cu where cu.tenant_id = p_tenant and cu.data_source <> 'simulated'
  ),
  -- Routers count towards each area they serve customers in.
  r as (
    select distinct c.ar, ro.id, ro.status
    from public.routers ro join c on c.router_id = ro.id
    where ro.tenant_id = p_tenant
  ),
  areas as (select distinct ar from c)
  select a.ar,
    (select count(*) from c where c.ar = a.ar and c.status <> 'terminated')::integer,
    (select count(*) from c where c.ar = a.ar and c.registered_on between p_from and p_to)::integer,
    (select count(*) from public.subscriptions s join c on c.id = s.customer_id where c.ar = a.ar and s.status = 'active')::integer,
    coalesce((select sum(p.amount) from public.payments p join c on c.id = p.customer_id
              where c.ar = a.ar and p.status = 'successful' and p.verification_status = 'verified' and p.data_source <> 'simulated'
                and (p.transaction_at at time zone v_tz)::date between p_from and p_to), 0)::numeric,
    coalesce((select sum(i.total - i.amount_paid) from public.invoices i join c on c.id = i.customer_id
              where c.ar = a.ar and i.status in ('issued', 'partially_paid')), 0)::numeric,
    (select count(*) from public.support_tickets t join c on c.id = t.customer_id
      where c.ar = a.ar and (t.created_at at time zone v_tz)::date between p_from and p_to)::integer,
    (select count(*) from public.support_tickets t join c on c.id = t.customer_id
      where c.ar = a.ar and t.status not in ('resolved', 'closed'))::integer,
    (select count(*) from r where r.ar = a.ar)::integer,
    (select count(*) from r where r.ar = a.ar and r.status = 'offline')::integer
  from areas a
  order by 5 desc, 2 desc, 1;
end;
$$;

revoke all on function public.bi_customer_report(uuid, date, date, text) from public, anon;
revoke all on function public.bi_subscription_report(uuid, date, date, text) from public, anon;
revoke all on function public.bi_payment_report(uuid, date, date) from public, anon;
revoke all on function public.bi_support_report(uuid, date, date) from public, anon;
revoke all on function public.bi_area_report(uuid, date, date) from public, anon;
grant execute on function public.bi_customer_report(uuid, date, date, text) to authenticated;
grant execute on function public.bi_subscription_report(uuid, date, date, text) to authenticated;
grant execute on function public.bi_payment_report(uuid, date, date) to authenticated;
grant execute on function public.bi_support_report(uuid, date, date) to authenticated;
grant execute on function public.bi_area_report(uuid, date, date) to authenticated;
