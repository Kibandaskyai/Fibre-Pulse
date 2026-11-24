-- =============================================================================
-- Pilot client update (24 Nov 2026)
--
-- What the pilot ISP told us:
--   * Internet comes from Safaricom to the ISP's server and is shared out
--     from there. When Safaricom's link is down, the app must say the network
--     is unavailable so the owner can call Safaricom.
--   * Most customers are HOTSPOT users who buy time (1 hour, 24 hours, 7 days,
--     a month...) for ONE phone or gadget at a time. Another family member
--     buys separately. When the time runs out they are cut off automatically.
--   * A minority pay monthly and have their own routers (PPPoE, as built).
--   * Payment is strictly M-Pesa to the paybill. No KRA, no VAT.
--   * The app shows how many people are online, and money per day and month.
--   * Up to about 10,000 end users.
--
-- Contents
--   1. Settings: accepted payment methods (M-Pesa only for new ISPs), paybill,
--      upstream provider and its support number.
--   2. Hotspot plans, devices and access codes ("vouchers").
--   3. Selling, free codes, cancelling, outage compensation (owner).
--   4. The public hotspot buying page (portal) and the M-Pesa confirmation
--      functions the software engineer wires to Daraja.
--   5. Expiry every minute, with a router disconnect for anyone still online.
--   6. Upstream (Safaricom) monitoring and network status.
--   7. Connector: set-based session ingest for thousands of sessions, hotspot
--      codes in the RADIUS policy, only sent when something changed.
--   8. Revenue split hotspot / monthly, daily and monthly.
--   9. SMS of access codes to customers.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Settings
-- -----------------------------------------------------------------------------

-- New ISPs registering through the app accept M-Pesa only (pilot rule: "payment
-- is strictly M-Pesa to the paybill"). The owner can change it in Settings.
create or replace function private.tenant_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is not null and not (new.settings ? 'payment_methods') then
    new.settings := new.settings || jsonb_build_object('payment_methods', jsonb_build_array('mpesa'));
  end if;
  if not (new.settings ? 'upstream_provider') then
    new.settings := new.settings || jsonb_build_object('upstream_provider', 'Safaricom');
  end if;
  return new;
end;
$$;
create trigger tenants_defaults before insert on public.tenants
  for each row execute function private.tenant_defaults();

-- Accepted payment methods. Unset means all methods (ISPs created before this
-- rule). Applies to every payment however it is written.
create or replace function private.accepted_methods(p_tenant uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select array_agg(x) from jsonb_array_elements_text(t.settings -> 'payment_methods') x),
    array['mpesa', 'bank_transfer', 'other'])
  from public.tenants t where t.id = p_tenant
$$;

create or replace function private.guard_payment_method()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reversal_of is null and not (new.method::text = any (private.accepted_methods(new.tenant_id))) then
    raise exception 'This ISP only accepts %.',
      (select string_agg(case m when 'mpesa' then 'M-Pesa' when 'bank_transfer' then 'bank transfers' else 'other methods' end, ', ')
       from unnest(private.accepted_methods(new.tenant_id)) m)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger payments_method_accepted before insert on public.payments
  for each row execute function private.guard_payment_method();

-- Owner settings for the pilot: paybill, payment methods, upstream provider.
create or replace function public.save_service_settings(
  p_tenant uuid,
  p_methods text[],
  p_paybill text,
  p_upstream_provider text,
  p_upstream_phone text,
  p_upstream_check_target text,
  p_hotspot_clock_start text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_methods text[] := array(select distinct m from unnest(coalesce(p_methods, '{}')) m where m is not null);
begin
  perform private.require_permission(p_tenant, 'settings:manage');
  if cardinality(v_methods) = 0 or not (v_methods <@ array['mpesa', 'bank_transfer', 'other']) then
    raise exception 'Choose at least one payment method.' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_paybill), '') <> '' and trim(p_paybill) !~ '^[0-9]{5,7}$' then
    raise exception 'A paybill number has 5 to 7 digits.' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_upstream_phone), '') <> '' and trim(p_upstream_phone) !~ '^[0-9+ ]{3,20}$' then
    raise exception 'Enter the support number as digits, for example 0722000100 or 100.' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_upstream_check_target), '') <> '' and private.try_inet(p_upstream_check_target) is null then
    raise exception 'The check address must be an IP address, for example 8.8.8.8.' using errcode = 'check_violation';
  end if;
  if p_hotspot_clock_start is not null and p_hotspot_clock_start not in ('payment', 'first_login') then
    raise exception 'Choose when hotspot time starts.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Service settings updated');
  update public.tenants
  set settings = settings || jsonb_build_object(
        'payment_methods', to_jsonb(v_methods),
        'mpesa_paybill', nullif(trim(p_paybill), ''),
        'upstream_provider', coalesce(nullif(left(trim(p_upstream_provider), 60), ''), 'Safaricom'),
        'upstream_support_phone', nullif(trim(p_upstream_phone), ''),
        'upstream_check_target', coalesce(host(private.try_inet(p_upstream_check_target)), '8.8.8.8'),
        'hotspot_clock_start', coalesce(p_hotspot_clock_start, settings ->> 'hotspot_clock_start', 'payment'))
  where id = p_tenant;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Hotspot tables
-- -----------------------------------------------------------------------------
create table public.hotspot_plans (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  name             text not null check (char_length(name) between 2 and 60),
  -- Time bought, in minutes (1 hour = 60, 24 hours = 1440, a month = 43200).
  duration_minutes integer not null check (duration_minutes between 10 and 527040),
  price            numeric(12, 2) not null check (price > 0 and price = round(price)),
  download_mbps    numeric(8, 2) not null check (download_mbps > 0),
  upload_mbps      numeric(8, 2) not null check (upload_mbps > 0),
  -- The ISP's own label, as in their current system ("Limited"/"Unlimited").
  usage_type       text not null default 'unlimited' check (usage_type in ('limited', 'unlimited')),
  -- Optional data cap in MB. Null = no cap.
  -- Limited plans: the data the buyer gets for the period. They are cut off
  -- when it runs out or the time ends, whichever comes first. Unlimited
  -- plans have no cap. Null on a Limited plan means "cap not set yet".
  data_limit_mb    integer check (data_limit_mb is null or data_limit_mb > 0),
  -- MikroTik hotspot user profile or RADIUS group, if the router uses one.
  network_profile  text check (network_profile is null or char_length(network_profile) <= 64),
  status           public.package_status not null default 'active',
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  check (usage_type = 'limited' or data_limit_mb is null)
);
create trigger hotspot_plans_updated_at before update on public.hotspot_plans
  for each row execute function private.set_updated_at();
create trigger hotspot_plans_audit after insert or update or delete on public.hotspot_plans
  for each row execute function private.audit_row_change();

-- One row per phone or gadget seen on the hotspot (by MAC address).
create table public.hotspot_devices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete restrict,
  mac_address   macaddr not null,
  last_phone    text check (last_phone is null or last_phone ~ '^\+254[0-9]{9}$'),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  purchases     integer not null default 0 check (purchases >= 0),
  total_spent   numeric(14, 2) not null default 0 check (total_spent >= 0),
  data_source   public.data_source not null default 'connector',
  unique (tenant_id, id),
  unique (tenant_id, mac_address)
);
create index hotspot_devices_seen_idx on public.hotspot_devices (tenant_id, last_seen_at desc);

-- An access code: what one purchase buys. Plan facts are copied so later plan
-- edits never change what someone paid for.
create table public.hotspot_vouchers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  code                text not null check (code ~ '^[A-Z0-9]{6,12}$'),
  plan_id             uuid not null,
  plan_name           text not null,
  price               numeric(12, 2) not null check (price >= 0),
  duration_minutes    integer not null check (duration_minutes > 0),
  download_mbps       numeric(8, 2) not null,
  upload_mbps         numeric(8, 2) not null,
  -- Data cap copied from a Limited plan at purchase (null = no cap).
  data_limit_mb       integer check (data_limit_mb is null or data_limit_mb > 0),
  source              public.hotspot_voucher_source not null,
  status              public.hotspot_voucher_status not null,
  phone               text check (phone is null or phone ~ '^\+254[0-9]{9}$'),
  -- The one device the code works on, learned when it is first used.
  device_id           uuid,
  mac_address         macaddr,
  router_id           uuid,
  payment_id          uuid unique,
  checkout_request_id text unique check (checkout_request_id is null or char_length(checkout_request_id) <= 100),
  reason              text check (reason is null or char_length(reason) <= 300),
  activated_at        timestamptz,
  expires_at          timestamptz,
  ended_at            timestamptz,
  end_reason          text,
  data_source         public.data_source not null,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  -- A code can expire unused when its time runs from payment.
  check (status <> 'active' or activated_at is not null),
  check (status <> 'active' or expires_at is not null),
  check (expires_at is null or activated_at is null or expires_at > activated_at),
  check (source <> 'complimentary' or (price = 0 and reason is not null)),
  check (source = 'complimentary' or status in ('awaiting_payment', 'payment_failed') or payment_id is not null),
  foreign key (tenant_id, plan_id) references public.hotspot_plans (tenant_id, id) on delete restrict,
  foreign key (tenant_id, device_id) references public.hotspot_devices (tenant_id, id) on delete set null (device_id),
  foreign key (tenant_id, router_id) references public.routers (tenant_id, id) on delete set null (router_id),
  foreign key (tenant_id, payment_id) references public.payments (tenant_id, id) on delete restrict
);
create index hotspot_vouchers_live_idx on public.hotspot_vouchers (tenant_id, status, expires_at)
  where status in ('awaiting_payment', 'unused', 'active');
create index hotspot_vouchers_recent_idx on public.hotspot_vouchers (tenant_id, created_at desc);
create index hotspot_vouchers_phone_idx on public.hotspot_vouchers (tenant_id, phone, created_at desc);
create index hotspot_vouchers_device_idx on public.hotspot_vouchers (tenant_id, device_id, created_at desc);
create index hotspot_vouchers_changed_idx on public.hotspot_vouchers (tenant_id, updated_at desc);
create index hotspot_vouchers_plan_idx on public.hotspot_vouchers (tenant_id, plan_id);
create trigger hotspot_vouchers_updated_at before update on public.hotspot_vouchers
  for each row execute function private.set_updated_at();

-- Every way of issuing a code copies the plan's data cap, so later plan edits
-- never change what someone bought.
create or replace function private.voucher_copy_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.data_limit_mb is null then
    select case when p.usage_type = 'limited' then p.data_limit_mb end into new.data_limit_mb
    from public.hotspot_plans p where p.id = new.plan_id;
  end if;
  return new;
end;
$$;
create trigger hotspot_vouchers_copy_cap before insert on public.hotspot_vouchers
  for each row execute function private.voucher_copy_cap();

-- When the clock starts (tenants.settings.hotspot_clock_start):
--   'payment' (default, the pilot's choice on 24 Nov 2026): time runs from the
--     moment the code is paid for (or given free), used or not.
--   'first_login': time runs from the first login; a paid code that is never
--     used never expires.
create or replace function private.hotspot_clock_start(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when t.settings ->> 'hotspot_clock_start' = 'first_login' then 'first_login' else 'payment' end
  from public.tenants t where t.id = p_tenant
$$;

create or replace function private.voucher_start_clock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'unused' and new.expires_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'unused')
     and private.hotspot_clock_start(new.tenant_id) = 'payment' then
    new.expires_at := now() + make_interval(mins => new.duration_minutes);
  end if;
  return new;
end;
$$;
create trigger hotspot_vouchers_start_clock before insert or update of status on public.hotspot_vouchers
  for each row execute function private.voucher_start_clock();

-- Data used by a code, kept apart from the code row so that usage updates
-- every minute do not count as a change to the code (which would make the
-- connector download the whole access list each time).
create table public.hotspot_voucher_usage (
  voucher_id   uuid primary key references public.hotspot_vouchers (id) on delete cascade,
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  closed_bytes bigint not null default 0 check (closed_bytes >= 0),  -- from sessions that have ended
  used_bytes   bigint not null default 0 check (used_bytes >= 0),    -- closed plus the session open now
  updated_at   timestamptz not null default now()
);
create index hotspot_voucher_usage_tenant_idx on public.hotspot_voucher_usage (tenant_id, updated_at desc);
alter table public.hotspot_voucher_usage enable row level security;
create policy hotspot_voucher_usage_select on public.hotspot_voucher_usage for select to authenticated
  using (private.has_permission(tenant_id, 'subscriptions:view'));
revoke all on public.hotspot_voucher_usage from anon;
-- Audit what people do (sales, free codes, cancellations, compensation);
-- not the thousands of automatic purchases and expiries a day.
create trigger hotspot_vouchers_audit after insert or update on public.hotspot_vouchers
  for each row when (new.source in ('staff', 'complimentary') or new.status = 'cancelled' or new.created_by is not null)
  execute function private.audit_row_change();

-- Lookups the hotspot needs at 10,000 users.
create index if not exists customers_pppoe_lower_idx on public.customers (tenant_id, lower(pppoe_username)) where pppoe_username is not null;
create index if not exists network_sessions_open_user_idx on public.network_sessions (router_id, session_type, username) where ended_at is null;
create index if not exists subscriptions_changed_idx on public.subscriptions (tenant_id, updated_at desc);
create index if not exists customers_changed_idx on public.customers (tenant_id, updated_at desc);

alter table public.hotspot_plans enable row level security;
alter table public.hotspot_devices enable row level security;
alter table public.hotspot_vouchers enable row level security;
create policy hotspot_plans_select on public.hotspot_plans for select to authenticated
  using (private.has_permission(tenant_id, 'packages:view'));
create policy hotspot_devices_select on public.hotspot_devices for select to authenticated
  using (private.has_permission(tenant_id, 'subscriptions:view'));
create policy hotspot_vouchers_select on public.hotspot_vouchers for select to authenticated
  using (private.has_permission(tenant_id, 'subscriptions:view'));
-- No write policies: every change goes through the functions below.
revoke all on public.hotspot_plans, public.hotspot_devices, public.hotspot_vouchers from anon;

-- Router commands can now be for a hotspot code instead of a customer.
alter table public.router_commands alter column customer_id drop not null;
alter table public.router_commands add column voucher_id uuid;
alter table public.router_commands
  add constraint router_commands_voucher_fk foreign key (tenant_id, voucher_id) references public.hotspot_vouchers (tenant_id, id) on delete cascade,
  add constraint router_commands_target check (customer_id is not null or voucher_id is not null);
comment on column public.router_commands.pppoe_username is 'PPPoE username, or the hotspot access code for disconnect_hotspot.';

-- -----------------------------------------------------------------------------
-- 3. Staff functions
-- -----------------------------------------------------------------------------

-- Short codes people can type on a phone: no 0/O or 1/I/L.
create or replace function private.new_voucher_code(p_tenant uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_chars constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_bytes bytea;
begin
  for attempt in 1..20 loop
    v_bytes := extensions.gen_random_bytes(6);
    v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(v_chars, (get_byte(v_bytes, i) % length(v_chars)) + 1, 1);
    end loop;
    if not exists (select 1 from public.hotspot_vouchers where tenant_id = p_tenant and code = v_code) then
      return v_code;
    end if;
  end loop;
  raise exception 'Could not make a unique code; try again.';
end;
$$;

create or replace function private.kenyan_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p is null then null
    when regexp_replace(p, '[\s-]', '', 'g') ~ '^\+254[17][0-9]{8}$' then regexp_replace(p, '[\s-]', '', 'g')
    when regexp_replace(p, '[\s-]', '', 'g') ~ '^254[17][0-9]{8}$' then '+' || regexp_replace(p, '[\s-]', '', 'g')
    when regexp_replace(p, '[\s-]', '', 'g') ~ '^0[17][0-9]{8}$' then '+254' || substr(regexp_replace(p, '[\s-]', '', 'g'), 2)
    when regexp_replace(p, '[\s-]', '', 'g') ~ '^[17][0-9]{8}$' then '+254' || regexp_replace(p, '[\s-]', '', 'g')
    else null
  end
$$;

create or replace function public.save_hotspot_plan(
  p_tenant uuid,
  p_plan uuid,
  p_name text,
  p_duration_minutes integer,
  p_price numeric,
  p_download_mbps numeric,
  p_upload_mbps numeric,
  p_usage_type text default 'unlimited',
  p_data_limit_mb integer default null,
  p_network_profile text default null,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_permission(p_tenant, 'packages:edit');
  if p_price is null or p_price <= 0 or p_price <> round(p_price) then
    raise exception 'Enter a price in whole shillings above zero (M-Pesa takes whole shillings).' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(case when p_plan is null then 'Hotspot plan created' else 'Hotspot plan changed' end);
  if p_plan is null then
    insert into public.hotspot_plans (tenant_id, name, duration_minutes, price, download_mbps, upload_mbps, usage_type, data_limit_mb, network_profile, sort_order)
    values (p_tenant, trim(p_name), p_duration_minutes, p_price, p_download_mbps, coalesce(p_upload_mbps, p_download_mbps),
            coalesce(p_usage_type, 'unlimited'), case when p_usage_type = 'limited' then p_data_limit_mb end, nullif(trim(p_network_profile), ''), coalesce(p_sort_order, 0))
    returning id into v_id;
  else
    update public.hotspot_plans
    set name = trim(p_name), duration_minutes = p_duration_minutes, price = p_price, download_mbps = p_download_mbps,
        upload_mbps = coalesce(p_upload_mbps, p_download_mbps), usage_type = coalesce(p_usage_type, 'unlimited'),
        data_limit_mb = case when p_usage_type = 'limited' then p_data_limit_mb end, network_profile = nullif(trim(p_network_profile), ''), sort_order = coalesce(p_sort_order, 0)
    where id = p_plan and tenant_id = p_tenant
    returning id into v_id;
    if v_id is null then
      raise exception 'Plan not found.' using errcode = 'no_data_found';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.set_hotspot_plan_status(p_plan uuid, p_status public.package_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.hotspot_plans where id = p_plan;
  perform private.require_permission(v_tenant, 'packages:edit');
  perform private.set_audit_reason('Hotspot plan ' || p_status::text);
  update public.hotspot_plans set status = p_status where id = p_plan;
end;
$$;

-- Owner sells a code after seeing the customer's M-Pesa payment (for example
-- a customer who paid the paybill and called). The payment is recorded like
-- any manual payment: it counts as collected once checked against the
-- statement (Payments > Reconcile).
create or replace function public.sell_hotspot_voucher(p_tenant uuid, p_plan uuid, p_phone text, p_mpesa_reference text)
returns table (voucher_id uuid, code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.hotspot_plans;
  v_phone text := private.kenyan_phone(p_phone);
  v_payment uuid;
  v_id uuid;
  v_code text;
  v_ref text := upper(trim(coalesce(p_mpesa_reference, '')));
  v_existing public.payments;
  v_other text;
begin
  perform private.require_permission(p_tenant, 'subscriptions:edit');
  perform private.require_permission(p_tenant, 'payments:record');
  select * into v_plan from public.hotspot_plans where id = p_plan and tenant_id = p_tenant and status = 'active';
  if v_plan.id is null then
    raise exception 'Choose a plan that is on sale.' using errcode = 'check_violation';
  end if;
  if p_phone is not null and trim(p_phone) <> '' and v_phone is null then
    raise exception 'Enter a Kenyan mobile number, for example 0712 345 678.' using errcode = 'check_violation';
  end if;
  if upper(trim(coalesce(p_mpesa_reference, ''))) !~ '^[A-Z0-9]{8,12}$' then
    raise exception 'Enter the M-Pesa transaction code, for example SKL4H7XY2Q.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Hotspot code issued by hand for M-Pesa ' || v_ref);
  -- One code per M-Pesa transaction. If the payment already reached
  -- FibrePulse (for example a paybill payment no plan matched, or one that
  -- came in while codes could not be sent), the code is tied to it; if it
  -- already has a code, the owner is told which one to resend.
  select * into v_existing from public.payments where tenant_id = p_tenant and method = 'mpesa' and provider_reference = v_ref for update;
  if v_existing.id is not null then
    select v.code into v_other from public.hotspot_vouchers v where v.payment_id = v_existing.id and v.status <> 'payment_failed';
    if v_other is not null then
      raise exception 'M-Pesa % already has WiFi code %. Resend it from the Codes page instead.', v_ref, v_other using errcode = 'unique_violation';
    end if;
    if v_existing.customer_id is not null then
      raise exception 'M-Pesa % is a monthly customer''s payment, not a hotspot purchase.', v_ref using errcode = 'check_violation';
    end if;
    if v_existing.status <> 'successful' or v_existing.reversal_of is not null then
      raise exception 'M-Pesa % is not a successful payment.', v_ref using errcode = 'check_violation';
    end if;
    if v_existing.amount < v_plan.price then
      raise exception 'M-Pesa % was Ksh %; the % plan costs Ksh %.', v_ref, v_existing.amount, v_plan.name, v_plan.price using errcode = 'check_violation';
    end if;
    -- A payment that only failed a WiFi-page purchase is released first.
    update public.hotspot_vouchers set payment_id = null where payment_id = v_existing.id and status = 'payment_failed';
    v_payment := v_existing.id;
    v_phone := coalesce(v_phone, v_existing.payer_phone);
  else
    insert into public.payments (tenant_id, method, provider_reference, amount, transaction_at, status, verification_status,
                                 revenue_category, data_source, payer_phone, description, recorded_by)
    values (p_tenant, 'mpesa', v_ref, v_plan.price, now(), 'successful', 'unverified',
            'subscription', 'manual', v_phone, 'Hotspot ' || v_plan.name, auth.uid())
    returning id into v_payment;
  end if;
  v_code := private.new_voucher_code(p_tenant);
  insert into public.hotspot_vouchers (tenant_id, code, plan_id, plan_name, price, duration_minutes, download_mbps, upload_mbps,
                                       source, status, phone, payment_id, data_source, created_by)
  values (p_tenant, v_code, v_plan.id, v_plan.name, v_plan.price, v_plan.duration_minutes, v_plan.download_mbps, v_plan.upload_mbps,
          'staff', 'unused', v_phone, v_payment, 'manual', auth.uid())
  returning id into v_id;
  perform private.queue_code_sms(v_id);
  return query select v_id, v_code;
end;
$$;

-- Free time from the owner, always with a reason.
create or replace function public.give_free_hotspot_voucher(p_tenant uuid, p_plan uuid, p_phone text, p_reason text)
returns table (voucher_id uuid, code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.hotspot_plans;
  v_phone text := private.kenyan_phone(p_phone);
  v_id uuid;
  v_code text;
begin
  perform private.require_permission(p_tenant, 'subscriptions:suspend');
  if char_length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a reason for the free code (at least 5 characters).' using errcode = 'check_violation';
  end if;
  select * into v_plan from public.hotspot_plans where id = p_plan and tenant_id = p_tenant and status <> 'archived';
  if v_plan.id is null then
    raise exception 'Plan not found.' using errcode = 'no_data_found';
  end if;
  perform private.set_audit_reason('Free hotspot code: ' || trim(p_reason));
  v_code := private.new_voucher_code(p_tenant);
  insert into public.hotspot_vouchers (tenant_id, code, plan_id, plan_name, price, duration_minutes, download_mbps, upload_mbps,
                                       source, status, phone, reason, data_source, created_by)
  values (p_tenant, v_code, v_plan.id, v_plan.name, 0, v_plan.duration_minutes, v_plan.download_mbps, v_plan.upload_mbps,
          'complimentary', 'unused', v_phone, left(trim(p_reason), 300), 'manual', auth.uid())
  returning id into v_id;
  perform private.queue_code_sms(v_id);
  return query select v_id, v_code;
end;
$$;

-- Queue a hotspot disconnect when the code is online somewhere right now.
create or replace function private.queue_hotspot_disconnect(p_voucher uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.hotspot_vouchers;
  s record;
begin
  select * into v from public.hotspot_vouchers where id = p_voucher;
  if not coalesce((select (settings ->> 'router_enforcement')::boolean from public.tenants where id = v.tenant_id), false) then
    return;
  end if;
  for s in select distinct ns.router_id from public.network_sessions ns
           where ns.tenant_id = v.tenant_id and ns.session_type = 'hotspot' and ns.ended_at is null and upper(ns.username) = v.code loop
    if not exists (select 1 from public.router_commands rc where rc.voucher_id = v.id and rc.router_id = s.router_id and rc.status in ('queued', 'sent')) then
      insert into public.router_commands (tenant_id, router_id, voucher_id, command_type, pppoe_username, status, reason, requested_by)
      values (v.tenant_id, s.router_id, v.id, 'disconnect_hotspot', v.code, 'queued', p_reason, auth.uid());
    end if;
  end loop;
end;
$$;

create or replace function public.cancel_hotspot_voucher(p_voucher uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.hotspot_vouchers;
begin
  select * into v from public.hotspot_vouchers where id = p_voucher for update;
  perform private.require_permission(v.tenant_id, 'subscriptions:suspend');
  if v.status not in ('unused', 'active') then
    raise exception 'Only unused or running codes can be cancelled.' using errcode = 'check_violation';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a reason (at least 5 characters).' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Hotspot code cancelled: ' || trim(p_reason));
  update public.hotspot_vouchers
  set status = 'cancelled', ended_at = now(), end_reason = left(trim(p_reason), 300)
  where id = v.id;
  perform private.queue_hotspot_disconnect(v.id, 'Code cancelled: ' || left(trim(p_reason), 200));
end;
$$;

-- After an outage, add the lost minutes to every running code (and to unused
-- ones nothing needs doing: their clock has not started).
create or replace function public.compensate_hotspot_outage(p_tenant uuid, p_minutes integer, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.require_permission(p_tenant, 'subscriptions:suspend');
  if p_minutes is null or p_minutes < 1 or p_minutes > 10080 then
    raise exception 'Add between 1 minute and 7 days.' using errcode = 'check_violation';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a reason (at least 5 characters).' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Outage compensation +' || p_minutes || ' min: ' || trim(p_reason));
  update public.hotspot_vouchers
  set expires_at = expires_at + make_interval(mins => p_minutes)
  where tenant_id = p_tenant and status in ('active', 'unused') and expires_at > now();
  get diagnostics v_count = row_count;
  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, after_data, reason)
  values (p_tenant, auth.uid(), 'compensate', 'hotspot_vouchers', null,
          jsonb_build_object('minutes', p_minutes, 'codes_extended', v_count), left(trim(p_reason), 500));
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. SMS of access codes to the buyer (delivered by `npm run worker:sms`)
-- -----------------------------------------------------------------------------
create table public.customer_sms_outbox (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  voucher_id uuid,
  phone      text not null check (phone ~ '^\+254[0-9]{9}$'),
  body       text not null check (char_length(body) <= 160),
  status     text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts   integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  foreign key (tenant_id, voucher_id) references public.hotspot_vouchers (tenant_id, id) on delete cascade
);
create index customer_sms_pending_idx on public.customer_sms_outbox (created_at) where status = 'pending';
alter table public.customer_sms_outbox enable row level security;
-- No policies: staff never read customers' SMS rows; the worker uses the service role.
revoke all on public.customer_sms_outbox from anon;

create or replace function private.queue_code_sms(p_voucher uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.hotspot_vouchers;
  v_isp text;
begin
  select * into v from public.hotspot_vouchers where id = p_voucher;
  if v.phone is null or v.data_source = 'simulated' then
    return;
  end if;
  select name into v_isp from public.tenants where id = v.tenant_id;
  insert into public.customer_sms_outbox (tenant_id, voucher_id, phone, body)
  values (v.tenant_id, v.id, v.phone,
          left(left(v_isp, 30) || ': your WiFi code is ' || v.code || ' for ' || v.plan_name ||
               '. Works on one device. ' ||
               case when v.expires_at is not null then 'Valid until ' || to_char(v.expires_at at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') || '.'
                    else 'Time starts when you log in.' end, 160));
end;
$$;

-- The owner (re)sends a code by SMS, optionally to a new number.
create or replace function public.resend_hotspot_code_sms(p_voucher uuid, p_phone text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.hotspot_vouchers;
  v_phone text := private.kenyan_phone(p_phone);
begin
  select * into v from public.hotspot_vouchers where id = p_voucher;
  if v.id is null then
    raise exception 'Code not found.' using errcode = 'no_data_found';
  end if;
  perform private.require_permission(v.tenant_id, 'subscriptions:edit');
  if coalesce(trim(p_phone), '') <> '' and v_phone is null then
    raise exception 'Enter a Kenyan mobile number, for example 0712 345 678.' using errcode = 'check_violation';
  end if;
  if v.status not in ('unused', 'active') then
    raise exception 'Only a code that still has time can be sent.' using errcode = 'check_violation';
  end if;
  if coalesce(v_phone, v.phone) is null then
    raise exception 'Enter the customer''s phone number.' using errcode = 'check_violation';
  end if;
  if v_phone is not null and v_phone is distinct from v.phone then
    perform private.set_audit_reason('Hotspot code sent to a new number');
    update public.hotspot_vouchers set phone = v_phone where id = v.id;
  end if;
  perform private.queue_code_sms(v.id);
end;
$$;

create or replace function public.customer_sms_claim(p_limit integer default 50)
returns table (id uuid, phone text, body text, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select o.id from public.customer_sms_outbox o
    where o.status = 'pending' and o.attempts < 5 and o.created_at > now() - interval '1 day'
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 500)
    for update skip locked
  )
  update public.customer_sms_outbox o set attempts = o.attempts + 1
  from picked where o.id = picked.id
  returning o.id, o.phone, o.body, o.attempts;
end;
$$;

create or replace function public.customer_sms_mark(p_id uuid, p_status text, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped', 'pending') then
    raise exception 'Unknown SMS status %', p_status using errcode = 'check_violation';
  end if;
  update public.customer_sms_outbox
  set status = p_status, last_error = left(p_error, 500), sent_at = case when p_status = 'sent' then now() else sent_at end
  where id = p_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The hotspot buying page (public) and M-Pesa confirmation
-- -----------------------------------------------------------------------------

-- What the buying page shows. Public: plan names and prices only.
create or replace function public.hotspot_portal(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tenants;
begin
  select * into t from public.tenants where slug = lower(trim(p_slug)) and status = 'active';
  if t.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'name', t.name,
    'paybill', t.settings ->> 'mpesa_paybill',
    'support_phone', t.contact_phone,
    'demo', coalesce((t.settings ->> 'portal_demo')::boolean, false),
    'clock_start', private.hotspot_clock_start(t.id),
    'network_ok', (private.network_state(t.id) ->> 'state') not in ('upstream_down', 'site_unreachable'),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'price', p.price, 'duration_minutes', p.duration_minutes,
                                          'download_mbps', p.download_mbps, 'usage_type', p.usage_type, 'data_limit_mb', p.data_limit_mb)
                       order by p.sort_order, p.duration_minutes, p.price)
      from public.hotspot_plans p where p.tenant_id = t.id and p.status = 'active'), '[]'::jsonb)
  );
end;
$$;

-- Start a purchase from the buying page. The server then sends the M-Pesa
-- prompt (Daraja STK push). Nothing is granted until M-Pesa confirms.
create or replace function public.hotspot_portal_buy(p_slug text, p_plan uuid, p_phone text, p_mac text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tenants;
  v_plan public.hotspot_plans;
  v_phone text := private.kenyan_phone(p_phone);
  v_id uuid;
begin
  select * into t from public.tenants where slug = lower(trim(p_slug)) and status = 'active';
  if t.id is null then
    raise exception 'This hotspot is not available.' using errcode = 'no_data_found';
  end if;
  if v_phone is null then
    raise exception 'Enter your M-Pesa number, for example 0712 345 678.' using errcode = 'check_violation';
  end if;
  select * into v_plan from public.hotspot_plans where id = p_plan and tenant_id = t.id and status = 'active';
  if v_plan.id is null then
    raise exception 'Choose a plan.' using errcode = 'check_violation';
  end if;
  if (private.network_state(t.id) ->> 'state') in ('upstream_down', 'site_unreachable') then
    raise exception 'The internet is down right now. Please do not pay until it is back.' using errcode = 'check_violation';
  end if;
  -- Abuse limits: a phone can have 3 unpaid prompts in 10 minutes, an ISP 300.
  if (select count(*) from public.hotspot_vouchers where tenant_id = t.id and phone = v_phone and status = 'awaiting_payment'
        and created_at > now() - interval '10 minutes') >= 3
     or (select count(*) from public.hotspot_vouchers where tenant_id = t.id and status = 'awaiting_payment'
           and created_at > now() - interval '10 minutes') >= 300 then
    raise exception 'Too many unpaid requests. Wait a few minutes and try again.' using errcode = 'check_violation';
  end if;
  insert into public.hotspot_vouchers (tenant_id, code, plan_id, plan_name, price, duration_minutes, download_mbps, upload_mbps,
                                       source, status, phone, mac_address, data_source)
  values (t.id, private.new_voucher_code(t.id), v_plan.id, v_plan.name, v_plan.price, v_plan.duration_minutes,
          v_plan.download_mbps, v_plan.upload_mbps, 'portal', 'awaiting_payment', v_phone, private.try_macaddr(p_mac), 'provider')
  returning id into v_id;
  return jsonb_build_object('voucher_id', v_id, 'amount', v_plan.price, 'phone', v_phone, 'plan', v_plan.name,
                            'account_reference', left(regexp_replace(t.slug, '[^a-z0-9]', '', 'g'), 12));
end;
$$;

-- The buying page polls this. The code is only shown once paid.
create or replace function public.hotspot_portal_status(p_slug text, p_voucher uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', v.status,
    'code', case when v.status in ('unused', 'active') then v.code end,
    'plan', v.plan_name,
    'expires_at', v.expires_at,
    'simulated', v.data_source = 'simulated')
  from public.hotspot_vouchers v
  join public.tenants t on t.id = v.tenant_id
  where v.id = p_voucher and t.slug = lower(trim(p_slug)) and v.created_at > now() - interval '2 days'
$$;

-- Demo ISPs only: pretend M-Pesa confirmed, with a SIMULATED payment that can
-- never be verified, never counts as revenue and never opens a real router.
create or replace function public.hotspot_portal_simulate_payment(p_slug text, p_voucher uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tenants;
  v public.hotspot_vouchers;
  v_payment uuid;
begin
  select * into t from public.tenants where slug = lower(trim(p_slug)) and status = 'active';
  if t.id is null or not coalesce((t.settings ->> 'portal_demo')::boolean, false) then
    raise exception 'Simulated payments are only for demo ISPs.' using errcode = 'insufficient_privilege';
  end if;
  select * into v from public.hotspot_vouchers where id = p_voucher and tenant_id = t.id and status = 'awaiting_payment' for update;
  if v.id is null then
    raise exception 'Nothing waiting for payment.' using errcode = 'no_data_found';
  end if;
  insert into public.payments (tenant_id, method, provider_reference, amount, transaction_at, status, verification_status,
                               revenue_category, data_source, payer_phone, description)
  values (t.id, 'mpesa', 'SIM' || upper(substr(replace(v.id::text, '-', ''), 1, 9)), v.price, now(), 'successful', 'unverified',
          'subscription', 'simulated', v.phone, 'SIMULATED hotspot purchase ' || v.plan_name)
  returning id into v_payment;
  update public.hotspot_vouchers set status = 'unused', payment_id = v_payment, data_source = 'simulated' where id = v.id;
end;
$$;

-- TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
-- The STK push route stores Safaricom's CheckoutRequestID on the code with
-- set_hotspot_checkout(), and the authenticated callback calls
-- confirm_hotspot_payment(). Both are for the service role only.
create or replace function public.set_hotspot_checkout(p_voucher uuid, p_checkout_request_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.hotspot_vouchers set checkout_request_id = left(trim(p_checkout_request_id), 100)
  where id = p_voucher and status = 'awaiting_payment'
$$;

create or replace function public.confirm_hotspot_payment(
  p_voucher uuid,
  p_success boolean,
  p_receipt text,
  p_amount numeric,
  p_phone text,
  p_transaction_at timestamptz,
  p_raw jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.hotspot_vouchers;
  v_payment uuid;
  v_other text;
begin
  select * into v from public.hotspot_vouchers where id = p_voucher for update;
  if v.id is null then
    raise exception 'Unknown hotspot purchase.' using errcode = 'no_data_found';
  end if;
  -- Safaricom retries callbacks: the same receipt twice changes nothing.
  if v.status <> 'awaiting_payment' then
    return jsonb_build_object('status', v.status, 'code', v.code, 'duplicate', true);
  end if;
  if not coalesce(p_success, false) then
    update public.hotspot_vouchers set status = 'payment_failed', ended_at = now(), end_reason = 'M-Pesa payment not completed'
    where id = v.id;
    return jsonb_build_object('status', 'payment_failed');
  end if;
  if coalesce(trim(p_receipt), '') = '' or p_amount is null then
    raise exception 'A successful M-Pesa result needs the receipt number and amount.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('M-Pesa confirmed hotspot purchase');
  -- The owner may already have issued a code by hand for this payment (for
  -- example while FibrePulse could not hear from M-Pesa). Never a second code.
  select p.id into v_payment from public.payments p
  where p.tenant_id = v.tenant_id and p.method = 'mpesa' and p.provider_reference = upper(trim(p_receipt));
  if v_payment is not null then
    select x.code into v_other from public.hotspot_vouchers x where x.payment_id = v_payment and x.status <> 'payment_failed';
    update public.hotspot_vouchers set status = 'payment_failed', ended_at = now(),
      end_reason = 'Paid, but code ' || coalesce(v_other, '?') || ' was already issued for M-Pesa ' || upper(trim(p_receipt))
    where id = v.id;
    return jsonb_build_object('status', 'payment_failed', 'reason', 'already_issued', 'code', v_other);
  end if;
  insert into public.payments (tenant_id, method, provider_reference, amount, transaction_at, status, verification_status,
                               verified_at, revenue_category, data_source, payer_phone, description, provider_payload)
  values (v.tenant_id, 'mpesa', upper(trim(p_receipt)), p_amount, coalesce(p_transaction_at, now()), 'successful', 'verified',
          now(), 'subscription', 'provider', coalesce(private.kenyan_phone(p_phone), v.phone), 'Hotspot ' || v.plan_name, p_raw)
  returning id into v_payment;
  if p_amount < v.price then
    update public.hotspot_vouchers set status = 'payment_failed', payment_id = v_payment, ended_at = now(),
      end_reason = 'Paid ' || p_amount || ', plan costs ' || v.price || '. Payment kept for follow-up.'
    where id = v.id;
    return jsonb_build_object('status', 'payment_failed', 'reason', 'underpaid');
  end if;
  update public.hotspot_vouchers set status = 'unused', payment_id = v_payment where id = v.id;
  perform private.queue_code_sms(v.id);
  return jsonb_build_object('status', 'unused', 'code', v.code);
end;
$$;

-- Money paid straight to the paybill (M-Pesa C2B confirmation). The amount
-- picks the plan (the ISP's prices are all different). If no plan costs that
-- much the payment is kept unlinked for the owner to sort out.
create or replace function public.record_paybill_hotspot_payment(
  p_tenant uuid,
  p_receipt text,
  p_amount numeric,
  p_phone text,
  p_account_reference text,
  p_transaction_at timestamptz,
  p_raw jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.hotspot_plans;
  v_payment uuid;
  v_phone text := private.kenyan_phone(p_phone);
  v_id uuid;
  v_code text;
  v_existing public.hotspot_vouchers;
begin
  if coalesce(trim(p_receipt), '') = '' or p_amount is null or p_amount <= 0 then
    raise exception 'Receipt and amount are required.' using errcode = 'check_violation';
  end if;
  select v.* into v_existing from public.hotspot_vouchers v join public.payments p on p.id = v.payment_id
  where p.tenant_id = p_tenant and p.method = 'mpesa' and p.provider_reference = upper(trim(p_receipt));
  if v_existing.id is not null then
    return jsonb_build_object('status', v_existing.status, 'code', v_existing.code, 'duplicate', true);
  end if;
  if exists (select 1 from public.payments where tenant_id = p_tenant and method = 'mpesa' and provider_reference = upper(trim(p_receipt))) then
    return jsonb_build_object('status', 'recorded', 'duplicate', true);
  end if;
  perform private.set_audit_reason('M-Pesa paybill payment');
  insert into public.payments (tenant_id, method, provider_reference, amount, transaction_at, status, verification_status,
                               verified_at, revenue_category, data_source, payer_phone, description, invoice_reference, provider_payload)
  values (p_tenant, 'mpesa', upper(trim(p_receipt)), p_amount, coalesce(p_transaction_at, now()), 'successful', 'verified',
          now(), 'subscription', 'provider', v_phone, 'Paybill payment', left(p_account_reference, 64), p_raw)
  returning id into v_payment;

  select * into v_plan from public.hotspot_plans
  where tenant_id = p_tenant and status = 'active' and price = p_amount
  order by (lower(name) = lower(trim(coalesce(p_account_reference, '')))) desc, duration_minutes desc
  limit 1;
  if v_plan.id is null then
    return jsonb_build_object('status', 'unmatched', 'payment_id', v_payment);
  end if;
  v_code := private.new_voucher_code(p_tenant);
  insert into public.hotspot_vouchers (tenant_id, code, plan_id, plan_name, price, duration_minutes, download_mbps, upload_mbps,
                                       source, status, phone, payment_id, data_source)
  values (p_tenant, v_code, v_plan.id, v_plan.name, v_plan.price, v_plan.duration_minutes, v_plan.download_mbps, v_plan.upload_mbps,
          'paybill', 'unused', v_phone, v_payment, 'provider')
  returning id into v_id;
  perform private.queue_code_sms(v_id);
  return jsonb_build_object('status', 'unused', 'code', v_code, 'voucher_id', v_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Expiry (every minute, every ISP)
-- -----------------------------------------------------------------------------
create or replace function private.expire_hotspot_vouchers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v record;
begin
  perform private.set_audit_reason('Hotspot time ended (scheduled check)');
  -- Unpaid prompts are dropped after 10 minutes.
  update public.hotspot_vouchers set status = 'payment_failed', ended_at = now(), end_reason = 'No M-Pesa confirmation within 10 minutes'
  where status = 'awaiting_payment' and created_at < now() - interval '10 minutes';

  -- Clock from payment: a code nobody used still runs out (never with
  -- 'first_login', where an unused code has no end time).
  update public.hotspot_vouchers set status = 'expired', ended_at = expires_at, end_reason = 'Time ended before the code was used'
  where status = 'unused' and expires_at <= now();

  v_count := 0;
  for v in
    update public.hotspot_vouchers set status = 'expired', ended_at = expires_at, end_reason = 'Time used up'
    where status = 'active' and expires_at <= now()
    returning id
  loop
    v_count := v_count + 1;
    perform private.queue_hotspot_disconnect(v.id, 'Hotspot time used up');
  end loop;
  return v_count;
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
  perform private.expire_hotspot_vouchers();
end;
$$;

do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname = 'fibrepulse-expire-subscriptions';
  -- Every minute: hotspot plans start at one hour.
  perform cron.schedule('fibrepulse-expire-subscriptions', '* * * * *', 'select private.scheduled_expiry()');
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Upstream (Safaricom) monitoring and network status
-- -----------------------------------------------------------------------------
alter table public.routers
  add column upstream_status     text not null default 'unknown' check (upstream_status in ('up', 'down', 'unknown')),
  add column upstream_checked_at timestamptz,
  add column upstream_failures   integer not null default 0 check (upstream_failures >= 0),
  add column upstream_down_since timestamptz,
  add column upstream_latency_ms numeric(8, 1),
  add column upstream_loss_pct   numeric(5, 1);

alter table public.network_metrics drop constraint if exists network_metrics_metric_check;
alter table public.network_metrics add constraint network_metrics_metric_check
  check (metric in ('cpu_load_pct', 'memory_used_pct', 'uptime_seconds', 'rx_bps', 'tx_bps', 'active_sessions', 'reachable',
                    'upstream_ok', 'upstream_latency_ms', 'hotspot_sessions', 'pppoe_sessions'));

-- One answer to "is my network up?" for an ISP:
--   ok                everything reporting normally
--   upstream_down     every router that checks the internet says it cannot
--                     reach it: the provider's link is down, call them
--   site_unreachable  no connector has reported for 3 minutes: power, the
--                     server, or the link itself may be down
--   not_monitored     no routers report through a connector yet
create or replace function private.network_state(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tenants;
  v_routers integer;
  v_real integer;
  v_checked integer;
  v_down integer;
  v_since timestamptz;
  v_agents integer;
  v_agents_quiet integer;
  v_last_seen timestamptz;
  v_hotspot integer;
  v_pppoe integer;
  v_sim_sessions integer;
  v_state text;
begin
  select * into t from public.tenants where id = p_tenant;
  select count(*), count(*) filter (where data_source <> 'simulated') into v_routers, v_real
  from public.routers where tenant_id = p_tenant and monitoring_enabled and connector_agent_id is not null;
  select count(*) filter (where upstream_checked_at > now() - interval '5 minutes'),
         count(*) filter (where upstream_checked_at > now() - interval '5 minutes' and upstream_status = 'down'),
         min(upstream_down_since) filter (where upstream_status = 'down')
  into v_checked, v_down, v_since
  from public.routers where tenant_id = p_tenant and monitoring_enabled;
  select count(*), count(*) filter (where last_seen_at is null or last_seen_at < now() - interval '3 minutes'), max(last_seen_at)
  into v_agents, v_agents_quiet, v_last_seen
  from public.connector_agents a
  where a.tenant_id = p_tenant and a.status = 'active'
    and exists (select 1 from public.routers r where r.connector_agent_id = a.id and r.monitoring_enabled);
  select count(*) filter (where session_type = 'hotspot'), count(*) filter (where session_type = 'pppoe'),
         count(*) filter (where data_source = 'simulated')
  into v_hotspot, v_pppoe, v_sim_sessions
  from public.network_sessions
  where tenant_id = p_tenant and ended_at is null and last_seen_at > now() - interval '10 minutes';

  v_state := case
    when v_routers = 0 then 'not_monitored'
    when v_agents > 0 and v_agents_quiet = v_agents then 'site_unreachable'
    when v_checked > 0 and v_down = v_checked then 'upstream_down'
    else 'ok' end;

  return jsonb_build_object(
    'state', v_state,
    'since', case v_state when 'upstream_down' then v_since when 'site_unreachable' then v_last_seen end,
    'provider', coalesce(t.settings ->> 'upstream_provider', 'Safaricom'),
    'provider_phone', t.settings ->> 'upstream_support_phone',
    'routers', v_routers,
    'routers_upstream_down', v_down,
    'simulated', v_routers > 0 and v_real = 0,
    'online_hotspot', case when v_state = 'site_unreachable' then null else v_hotspot end,
    'online_pppoe', case when v_state = 'site_unreachable' then null else v_pppoe end,
    'online_total', case when v_state = 'site_unreachable' then null else v_hotspot + v_pppoe end,
    'online_simulated', v_sim_sessions > 0
  );
end;
$$;

-- Any member of the ISP may see whether the network is up.
create or replace function public.network_status(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_tenant) then
    raise exception 'You do not have permission to do that.' using errcode = 'insufficient_privilege';
  end if;
  return private.network_state(p_tenant);
end;
$$;

-- Hotspot figures for the dashboard and the Hotspot page.
create or replace function public.hotspot_summary(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_out jsonb;
begin
  perform private.require_permission(p_tenant, 'subscriptions:view');
  select coalesce(timezone, 'Africa/Nairobi') into v_tz from public.tenants where id = p_tenant;
  v_today := (now() at time zone v_tz)::date;
  select jsonb_build_object(
    'active_codes', count(*) filter (where status = 'active' and expires_at > now()),
    'unused_codes', count(*) filter (where status = 'unused'),
    'awaiting_payment', count(*) filter (where status = 'awaiting_payment'),
    'sold_today', count(*) filter (where status not in ('awaiting_payment', 'payment_failed') and source <> 'complimentary'
                                       and (created_at at time zone v_tz)::date = v_today),
    'sales_today', coalesce(sum(price) filter (where status not in ('awaiting_payment', 'payment_failed') and source <> 'complimentary'
                                       and (created_at at time zone v_tz)::date = v_today), 0),
    'free_today', count(*) filter (where source = 'complimentary' and (created_at at time zone v_tz)::date = v_today),
    'expiring_hour', count(*) filter (where status = 'active' and expires_at between now() and now() + interval '1 hour'),
    'simulated', count(*) filter (where data_source = 'simulated' and status in ('unused', 'active')) > 0
  ) into v_out
  from public.hotspot_vouchers
  where tenant_id = p_tenant
    and (status in ('awaiting_payment', 'unused', 'active') or created_at >= (v_today::timestamp at time zone v_tz));

  return v_out || jsonb_build_object(
    'devices', (select count(*) from public.hotspot_devices where tenant_id = p_tenant),
    'devices_30d', (select count(*) from public.hotspot_devices where tenant_id = p_tenant and last_seen_at > now() - interval '30 days'),
    'plans', (select count(*) from public.hotspot_plans where tenant_id = p_tenant and status <> 'archived'),
    'plans_unlimited', (select count(*) from public.hotspot_plans where tenant_id = p_tenant and status <> 'archived' and usage_type = 'unlimited'),
    'by_plan_today', coalesce((
      select jsonb_agg(jsonb_build_object('plan', plan_name, 'count', n, 'amount', amt) order by amt desc)
      from (select plan_name, count(*) n, sum(price) amt from public.hotspot_vouchers
            where tenant_id = p_tenant and status not in ('awaiting_payment', 'payment_failed') and source <> 'complimentary'
              and created_at >= (v_today::timestamp at time zone v_tz)
            group by plan_name) x), '[]'::jsonb),
    'active_by_plan', coalesce((
      select jsonb_object_agg(plan_id, n)
      from (select plan_id, count(*) n from public.hotspot_vouchers
            where tenant_id = p_tenant and status = 'active' and expires_at > now() group by plan_id) x), '{}'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Connector
-- -----------------------------------------------------------------------------

-- Who may connect: PPPoE customers (as before) plus every live hotspot code.
-- Simulated codes are never sent to a real network.
create or replace function private.radius_access_list(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_agg(e order by e ->> 'username') from (
      select jsonb_build_object(
               'username', c.pppoe_username,
               'kind', 'pppoe',
               'allowed', s.id is not null and c.status = 'active',
               'download_mbps', p.download_mbps,
               'upload_mbps', p.upload_mbps,
               'expires_at', s.expires_at) as e
      from public.customers c
      left join public.subscriptions s on s.customer_id = c.id and s.status = 'active' and s.expires_at > now()
      left join public.service_packages p on p.id = s.package_id
      where c.tenant_id = p_tenant and coalesce(c.pppoe_username, '') <> '' and c.data_source <> 'simulated'
      union all
      select jsonb_build_object(
               'username', v.code,
               'kind', 'hotspot',
               'allowed', true,
               'download_mbps', v.download_mbps,
               'upload_mbps', v.upload_mbps,
               'expires_at', v.expires_at,
               'duration_seconds', v.duration_minutes * 60,
               'mac', v.mac_address::text,
               'data_left_bytes', case when v.data_limit_mb is not null
                 then greatest(v.data_limit_mb::bigint * 1048576 - coalesce(u.used_bytes, 0), 0) end)
      from public.hotspot_vouchers v
      left join public.hotspot_voucher_usage u on u.voucher_id = v.id
      where v.tenant_id = p_tenant and v.status in ('unused', 'active') and v.data_source <> 'simulated'
        and (v.expires_at is null or v.expires_at > now())
    ) x), '[]'::jsonb)
$$;

-- Changes only when something that affects access changed, so the connector
-- downloads the list only then (it can hold thousands of codes).
create or replace function private.radius_version(p_tenant uuid, p_mode text, p_enforce boolean)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(concat_ws('|', p_mode, p_enforce,
    (select max(updated_at) from public.hotspot_vouchers where tenant_id = p_tenant),
    (select max(updated_at) from public.subscriptions where tenant_id = p_tenant),
    (select max(updated_at) from public.customers where tenant_id = p_tenant),
    (select count(*) from public.hotspot_vouchers where tenant_id = p_tenant and status in ('unused', 'active')),
    -- Data left on Limited codes, refreshed at most every 5 minutes.
    (select date_bin('5 minutes', max(updated_at), timestamptz '2000-01-01') from public.hotspot_voucher_usage where tenant_id = p_tenant)))
$$;

drop function if exists public.connector_sync(text, text, timestamptz, text);
create or replace function public.connector_sync(
  p_token text, p_nonce text, p_ts timestamptz, p_version text default null, p_radius_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.connector_agents;
  v_enforce boolean;
  v_mode text;
  v_target text;
  v_routers jsonb;
  v_commands jsonb;
  v_radius_version text;
begin
  v_agent := private.authenticate_connector(p_token, p_nonce, p_ts);
  perform private.set_audit_reason('Connector sync');
  update public.connector_agents
  set status = 'active', last_seen_at = now(), agent_version = left(coalesce(p_version, agent_version), 40)
  where id = v_agent.id and (status <> 'active' or last_seen_at is null or last_seen_at < now() - interval '1 minute'
                             or agent_version is distinct from left(coalesce(p_version, agent_version), 40));
  perform private.clear_alert(v_agent.tenant_id, 'connector_offline:' || v_agent.id, 'Connector is reporting again.');

  select coalesce((t.settings ->> 'router_enforcement')::boolean, false), coalesce(t.settings ->> 'access_control', 'router_secrets'),
         coalesce(t.settings ->> 'upstream_check_target', '8.8.8.8')
  into v_enforce, v_mode, v_target from public.tenants t where t.id = v_agent.tenant_id;

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

  if v_mode = 'radius' and v_enforce then
    v_radius_version := private.radius_version(v_agent.tenant_id, v_mode, v_enforce);
  end if;

  return jsonb_build_object(
    'agent_id', v_agent.id,
    'tenant_id', v_agent.tenant_id,
    'poll_interval_seconds', 60,
    'router_enforcement', v_enforce,
    'access_control', v_mode,
    'upstream_check_target', v_target,
    'routers', v_routers,
    'commands', v_commands,
    'radius_version', v_radius_version,
    -- Only when the ISP uses RADIUS with enforcement on, and only when the
    -- list changed since the version the connector already holds.
    'radius_access', case when v_radius_version is not null and v_radius_version is distinct from p_radius_version
                          then private.radius_access_list(v_agent.tenant_id) else null end,
    'server_time', now()
  );
end;
$$;
revoke all on function public.connector_sync(text, text, timestamptz, text, text) from public;
grant execute on function public.connector_sync(text, text, timestamptz, text, text) to anon, authenticated;

-- Telemetry. Same rules as Phase 4, plus:
--   * sessions are matched and updated in a few set-based statements, so a
--     router with thousands of hotspot users is cheap to ingest;
--   * a hotspot session whose user name is an unused code starts that code's
--     clock and ties it to the device's MAC address;
--   * the upstream check (can the router reach the internet?) is stored and
--     raises "Internet from <provider> is down" after two failed checks.
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
  v_router public.routers;
  v_at timestamptz;
  v_reachable boolean;
  v_cpu numeric;
  v_mem numeric;
  v_uptime bigint;
  v_iface uuid;
  v_rx bigint;
  v_tx bigint;
  v_active int;
  v_hs int;
  v_capped uuid;
  v_up_ok boolean;
  v_provider text;
  v_phone text;
  v_accepted int := 0;
  v_rejected jsonb := '[]'::jsonb;
begin
  v_agent := private.authenticate_connector(p_token, p_nonce, p_ts);
  if jsonb_typeof(p_payload -> 'routers') <> 'array' or jsonb_array_length(p_payload -> 'routers') > 200 then
    raise exception 'Payload must list at most 200 routers.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason('Connector telemetry');
  update public.connector_agents set status = 'active', last_seen_at = now() where id = v_agent.id;
  select coalesce(settings ->> 'upstream_provider', 'Safaricom'), settings ->> 'upstream_support_phone'
  into v_provider, v_phone from public.tenants where id = v_agent.tenant_id;

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

    -- Upstream: can this router reach the internet?
    if jsonb_typeof(r -> 'upstream') = 'object' and (r -> 'upstream' ? 'reachable') then
      v_up_ok := coalesce((r #>> '{upstream,reachable}')::boolean, false);
      update public.routers
      set upstream_checked_at = v_at,
          upstream_latency_ms = least(greatest(private.try_numeric(r #>> '{upstream,avg_ms}'), 0), 9999999),
          upstream_loss_pct = least(greatest(private.try_numeric(r #>> '{upstream,loss_pct}'), 0), 100),
          upstream_failures = case when v_up_ok then 0 else upstream_failures + 1 end,
          upstream_status = case when v_up_ok then 'up' when upstream_failures + 1 >= 2 then 'down' else upstream_status end,
          upstream_down_since = case when v_up_ok then null else coalesce(upstream_down_since, v_at) end
      where id = v_router.id;
      insert into public.network_metrics (tenant_id, router_id, metric, value, recorded_at, data_source)
      values (v_router.tenant_id, v_router.id, 'upstream_ok', case when v_up_ok then 1 else 0 end, v_at, v_src);
      if v_up_ok then
        if private.try_numeric(r #>> '{upstream,avg_ms}') is not null then
          insert into public.network_metrics (tenant_id, router_id, metric, value, recorded_at, data_source)
          values (v_router.tenant_id, v_router.id, 'upstream_latency_ms', private.try_numeric(r #>> '{upstream,avg_ms}'), v_at, v_src);
        end if;
        perform private.clear_alert(v_router.tenant_id, 'upstream_down:' || v_router.id,
          'Internet back at ' || to_char(v_at at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') || '.');
      elsif v_router.upstream_failures + 1 >= 2 then
        perform private.raise_alert(v_router.tenant_id, v_router.id, 'upstream_down:' || v_router.id, 'upstream_down', 'critical',
          'Internet from ' || v_provider || ' is down at ' || v_router.name,
          'The router cannot reach the internet (' || coalesce(r #>> '{upstream,target}', 'check address') || '). Customers have no internet. '
          || 'Contact ' || v_provider || coalesce(' on ' || v_phone, '') || '.', v_src);
      end if;
    end if;

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

    -- Active sessions, set-based (up to 10,000 per router per reading).
    if jsonb_typeof(r -> 'sessions') = 'array' then
      create temporary table if not exists pg_temp.fp_incoming (
        session_type public.session_type, username text, ip inet, caller_id text, uptime numeric, bytes_in bigint, bytes_out bigint
      ) on commit drop;
      truncate pg_temp.fp_incoming;
      insert into pg_temp.fp_incoming
      select distinct on (x.t, x.u) x.t, x.u, private.try_inet(x.s ->> 'address'), left(x.s ->> 'caller_id', 64),
             least(coalesce(greatest(private.try_numeric(x.s ->> 'uptime_seconds'), 0), 0), 31536000),
             greatest(private.try_numeric(x.s ->> 'bytes_in'), 0)::bigint,
             greatest(private.try_numeric(x.s ->> 'bytes_out'), 0)::bigint
      from (
        select (e.value ->> 'type')::public.session_type t, left(trim(e.value ->> 'username'), 128) u, e.value s
        from (select value from jsonb_array_elements(r -> 'sessions') limit 10000) e
        where coalesce(e.value ->> 'type', '') in ('pppoe', 'hotspot') and coalesce(trim(e.value ->> 'username'), '') <> ''
      ) x;
      analyze pg_temp.fp_incoming;

      update public.network_sessions ns
      set last_seen_at = v_at, ip_address = coalesce(inc.ip, ns.ip_address),
          bytes_in = coalesce(inc.bytes_in, ns.bytes_in), bytes_out = coalesce(inc.bytes_out, ns.bytes_out)
      from pg_temp.fp_incoming inc
      where ns.router_id = v_router.id and ns.ended_at is null and ns.session_type = inc.session_type and ns.username = inc.username;

      insert into public.network_sessions (tenant_id, router_id, customer_id, session_type, username, ip_address, caller_id,
                                           started_at, last_seen_at, bytes_in, bytes_out, data_source)
      select v_router.tenant_id, v_router.id,
             case when inc.session_type = 'pppoe' then (
               select c.id from public.customers c
               where c.tenant_id = v_router.tenant_id and lower(c.pppoe_username) = lower(inc.username) limit 1) end,
             inc.session_type, inc.username, inc.ip, inc.caller_id,
             v_at - make_interval(secs => inc.uptime), v_at, coalesce(inc.bytes_in, 0), coalesce(inc.bytes_out, 0), v_src
      from pg_temp.fp_incoming inc
      where not exists (
        select 1 from public.network_sessions ns
        where ns.router_id = v_router.id and ns.ended_at is null and ns.session_type = inc.session_type and ns.username = inc.username);

      -- Learn which router holds a PPPoE customer's secret.
      update public.customers c set router_id = v_router.id
      from public.network_sessions ns
      where ns.router_id = v_router.id and ns.ended_at is null and ns.session_type = 'pppoe'
        and ns.customer_id = c.id and c.router_id is null;

      with closed as (
        update public.network_sessions set ended_at = greatest(v_at, started_at)
        where router_id = v_router.id and ended_at is null and last_seen_at < v_at
        returning session_type, username, bytes_in + bytes_out as bytes
      ), per_code as (
        select upper(username) as code, sum(bytes) as bytes from closed where session_type = 'hotspot' group by 1
      )
      update public.hotspot_voucher_usage u
      set closed_bytes = u.closed_bytes + pc.bytes, used_bytes = u.closed_bytes + pc.bytes, updated_at = now()
      from per_code pc
      join public.hotspot_vouchers v on v.tenant_id = v_router.tenant_id and v.code = pc.code and v.status = 'active'
      where u.voucher_id = v.id;

      -- A code seen online for the first time: start its clock on that device.
      create temporary table if not exists pg_temp.fp_activated (id uuid, mac macaddr, phone text, price numeric) on commit drop;
      truncate pg_temp.fp_activated;
      with act as (
        update public.hotspot_vouchers v
        set status = 'active', activated_at = least(v_at - make_interval(secs => inc.uptime), now()),
            expires_at = coalesce(v.expires_at, least(v_at - make_interval(secs => inc.uptime), now()) + make_interval(mins => v.duration_minutes)),
            mac_address = coalesce(v.mac_address, private.try_macaddr(inc.caller_id)), router_id = v_router.id
        from pg_temp.fp_incoming inc
        where inc.session_type = 'hotspot'
          and v.tenant_id = v_router.tenant_id and v.code = upper(inc.username) and v.status = 'unused'
          and (v.expires_at is null or v.expires_at > greatest(v_at - make_interval(secs => inc.uptime), v.created_at) + interval '1 second')
          and (v.data_source = 'simulated') = v_simulated
        returning v.id, v.mac_address, v.phone, v.price
      )
      insert into pg_temp.fp_activated select * from act;

      if found then
        insert into public.hotspot_devices as d (tenant_id, mac_address, last_phone, purchases, total_spent, data_source)
        select v_router.tenant_id, a.mac, max(a.phone), count(*), sum(a.price), v_src
        from pg_temp.fp_activated a where a.mac is not null group by a.mac
        on conflict (tenant_id, mac_address) do update
        set last_seen_at = now(), purchases = d.purchases + excluded.purchases, total_spent = d.total_spent + excluded.total_spent,
            last_phone = coalesce(excluded.last_phone, d.last_phone);
        update public.hotspot_vouchers v set device_id = d.id
        from pg_temp.fp_activated a
        join public.hotspot_devices d on d.tenant_id = v_router.tenant_id and d.mac_address = a.mac
        where v.id = a.id;
      end if;

      -- Data used on Limited codes: ended sessions plus the one open now. A code
      -- whose cap is used up ends now, like time running out.
      insert into public.hotspot_voucher_usage as u (voucher_id, tenant_id, used_bytes)
      select v.id, v.tenant_id, coalesce(inc.bytes_in, 0) + coalesce(inc.bytes_out, 0)
      from pg_temp.fp_incoming inc
      join public.hotspot_vouchers v on v.tenant_id = v_router.tenant_id and v.code = upper(inc.username)
      where inc.session_type = 'hotspot' and v.status = 'active' and v.data_limit_mb is not null
        and (v.data_source = 'simulated') = v_simulated
      on conflict (voucher_id) do update
      set used_bytes = u.closed_bytes + excluded.used_bytes, updated_at = now()
      where u.used_bytes is distinct from u.closed_bytes + excluded.used_bytes;

      perform private.set_audit_reason('Hotspot data used up');
      for v_capped in
        update public.hotspot_vouchers v
        set status = 'expired', ended_at = now(), end_reason = 'Data used up'
        from public.hotspot_voucher_usage u, pg_temp.fp_incoming inc
        where u.voucher_id = v.id and inc.session_type = 'hotspot' and v.code = upper(inc.username)
          and v.tenant_id = v_router.tenant_id and v.status = 'active' and v.data_limit_mb is not null
          and u.used_bytes >= v.data_limit_mb::bigint * 1048576
        returning v.id
      loop
        perform private.queue_hotspot_disconnect(v_capped, 'Hotspot data used up');
      end loop;

      select count(*), count(*) filter (where session_type = 'hotspot') into v_active, v_hs
      from public.network_sessions where router_id = v_router.id and ended_at is null;
      insert into public.network_metrics (tenant_id, router_id, metric, value, recorded_at, data_source)
      values (v_router.tenant_id, v_router.id, 'active_sessions', v_active, v_at, v_src),
             (v_router.tenant_id, v_router.id, 'hotspot_sessions', v_hs, v_at, v_src),
             (v_router.tenant_id, v_router.id, 'pppoe_sessions', v_active - v_hs, v_at, v_src);
    end if;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'rejected', v_rejected);
end;
$$;

-- Command results: hotspot codes have no customer name.
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
  v_who text;
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
    return;
  end if;
  perform private.set_audit_reason('Connector command result');
  update public.router_commands
  set status = case when p_success then 'succeeded'::public.router_command_status else 'failed'::public.router_command_status end,
      completed_at = now(), result_message = left(p_message, 300)
  where id = v_cmd.id;
  if not p_success then
    if v_cmd.voucher_id is not null then
      v_who := 'hotspot code ' || v_cmd.pppoe_username;
    else
      select full_name into v_who from public.customers where id = v_cmd.customer_id;
    end if;
    perform private.raise_alert(v_cmd.tenant_id, v_cmd.router_id, 'command_failed:' || v_cmd.id, 'command_failed', 'warning',
      'Could not ' || case when v_cmd.command_type::text like 'disconnect%' then 'disconnect ' else 'reconnect ' end || coalesce(v_who, 'a customer'),
      left(coalesce(p_message, 'The router refused the command.'), 300), 'connector');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Revenue: hotspot vs monthly, by day or month
-- -----------------------------------------------------------------------------
create or replace function public.revenue_by_service(p_tenant uuid, p_from date, p_to date, p_grain text default 'day')
returns table (bucket date, hotspot numeric, monthly numeric, unlinked numeric, hotspot_sales integer, awaiting_verification numeric)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text := private.require_revenue_view(p_tenant);
  v_step interval;
begin
  if p_grain not in ('day', 'month') then
    raise exception 'Grain must be day or month.' using errcode = 'check_violation';
  end if;
  if p_from is null or p_to is null or p_to < p_from or (p_grain = 'day' and p_to - p_from > 400) or p_to - p_from > 3660 then
    raise exception 'Choose a shorter date range.' using errcode = 'check_violation';
  end if;
  v_step := case p_grain when 'day' then interval '1 day' else interval '1 month' end;
  return query
  with buckets as (
    select gs::date as b
    from generate_series(date_trunc(p_grain, p_from::timestamp), date_trunc(p_grain, p_to::timestamp), v_step) gs
  ),
  pay as (
    select date_trunc(p_grain, (p.transaction_at at time zone v_tz))::date as b, p.amount, p.verification_status,
           case when v.id is not null then 'hotspot' when p.customer_id is not null then 'monthly' else 'unlinked' end as svc
    from public.payments p
    left join public.hotspot_vouchers v on v.payment_id = p.id
    where p.tenant_id = p_tenant and p.status = 'successful' and p.data_source <> 'simulated'
      and p.transaction_at >= (p_from::timestamp at time zone v_tz)
      and p.transaction_at < ((p_to + 1)::timestamp at time zone v_tz)
  )
  select bk.b,
         coalesce(sum(pay.amount) filter (where pay.verification_status = 'verified' and pay.svc = 'hotspot'), 0)::numeric,
         coalesce(sum(pay.amount) filter (where pay.verification_status = 'verified' and pay.svc = 'monthly'), 0)::numeric,
         coalesce(sum(pay.amount) filter (where pay.verification_status = 'verified' and pay.svc = 'unlinked'), 0)::numeric,
         (count(*) filter (where pay.verification_status = 'verified' and pay.svc = 'hotspot'))::integer,
         coalesce(sum(pay.amount) filter (where pay.verification_status = 'unverified'), 0)::numeric
  from buckets bk
  left join pay on pay.b = bk.b
  group by bk.b
  order by bk.b;
end;
$$;

-- revenue_breakdown: add "service" (Hotspot / Monthly / Not linked) and show
-- hotspot money under "Hotspot: <plan>" in the package breakdown.
create or replace function public.revenue_breakdown(p_tenant uuid, p_from date, p_to date, p_dimension text, p_area text default null)
returns table (label text, amount numeric, payments integer)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text := private.require_revenue_view(p_tenant);
begin
  if p_dimension not in ('package', 'area', 'method', 'service') then
    raise exception 'Unknown breakdown.' using errcode = 'check_violation';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation';
  end if;

  if p_dimension = 'method' then
    return query
    select case p.method when 'mpesa' then 'M-Pesa' when 'bank_transfer' then 'Bank transfer' else 'Other' end,
           sum(p.amount)::numeric, count(*)::integer
    from public.payments p
    where p.tenant_id = p_tenant and p.status = 'successful' and p.verification_status = 'verified'
      and (p.transaction_at at time zone v_tz)::date between p_from and p_to
      and (p_area is null or trim(p_area) = '' or (p.customer_id is not null and private.in_area(p.customer_id, p_area)))
    group by 1 order by 2 desc;

  elsif p_dimension = 'service' then
    return query
    select case when v.id is not null then 'Hotspot' when p.customer_id is not null then 'Monthly (own router)' else 'Not linked to a customer' end,
           sum(p.amount)::numeric, count(*)::integer
    from public.payments p
    left join public.hotspot_vouchers v on v.payment_id = p.id
    where p.tenant_id = p_tenant and p.status = 'successful' and p.verification_status = 'verified'
      and (p.transaction_at at time zone v_tz)::date between p_from and p_to
      and (p_area is null or trim(p_area) = '' or (p.customer_id is not null and private.in_area(p.customer_id, p_area)))
    group by 1 order by 2 desc;

  elsif p_dimension = 'area' then
    return query
    select coalesce(nullif(c.estate, ''), nullif(c.town, ''), nullif(c.county, ''),
                    case when v.id is not null then 'Hotspot (no area)' when p.customer_id is null then 'Not linked to a customer' else 'No area recorded' end),
           sum(p.amount)::numeric, count(*)::integer
    from public.payments p
    left join public.customers c on c.id = p.customer_id
    left join public.hotspot_vouchers v on v.payment_id = p.id
    where p.tenant_id = p_tenant and p.status = 'successful' and p.verification_status = 'verified'
      and (p.transaction_at at time zone v_tz)::date between p_from and p_to
      and (p_area is null or trim(p_area) = '' or (p.customer_id is not null and private.in_area(p.customer_id, p_area)))
    group by 1 order by 2 desc;

  else
    return query
    with pay as (
      select p.id, p.amount, v.plan_name as hotspot_plan
      from public.payments p
      left join public.hotspot_vouchers v on v.payment_id = p.id
      where p.tenant_id = p_tenant and p.status = 'successful' and p.verification_status = 'verified'
        and (p.transaction_at at time zone v_tz)::date between p_from and p_to
        and (p_area is null or trim(p_area) = '' or (p.customer_id is not null and private.in_area(p.customer_id, p_area)))
    ),
    alloc as (
      select a.payment_id, a.amount,
             coalesce(sp.name,
                      (select case il.category when 'installation' then 'Installation charges' when 'equipment' then 'Equipment'
                                               when 'other' then 'Other charges' else 'Other subscription charges' end
                       from public.invoice_lines il where il.invoice_id = i.id order by il.created_at limit 1),
                      'Other charges') as lbl
      from public.payment_allocations a
      join pay on pay.id = a.payment_id
      join public.invoices i on i.id = a.invoice_id
      left join public.subscriptions s on s.id = i.subscription_id
      left join public.service_packages sp on sp.id = s.package_id
    ),
    unapplied as (
      select pay.id, pay.amount - coalesce((select sum(x.amount) from alloc x where x.payment_id = pay.id), 0) as amount
      from pay where pay.hotspot_plan is null
    )
    select x.lbl, sum(x.amount)::numeric, count(distinct x.payment_id)::integer
    from (
      select alloc.lbl, alloc.amount, alloc.payment_id from alloc
      union all
      select 'Hotspot: ' || pay.hotspot_plan, pay.amount, pay.id from pay where pay.hotspot_plan is not null
      union all
      select 'Credit not yet applied to an invoice', u.amount, u.id from unapplied u where u.amount > 0
    ) x
    group by 1 order by 2 desc;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on function private.tenant_defaults() from public, anon, authenticated;
revoke all on function private.accepted_methods(uuid) from public, anon;
grant execute on function private.accepted_methods(uuid) to authenticated;
revoke all on function private.guard_payment_method() from public, anon, authenticated;
revoke all on function private.new_voucher_code(uuid) from public, anon, authenticated;
revoke all on function private.queue_hotspot_disconnect(uuid, text) from public, anon, authenticated;
revoke all on function private.queue_code_sms(uuid) from public, anon, authenticated;
revoke all on function private.expire_hotspot_vouchers() from public, anon, authenticated;
revoke all on function private.network_state(uuid) from public, anon, authenticated;
revoke all on function private.radius_version(uuid, text, boolean) from public, anon, authenticated;

revoke all on function public.save_service_settings(uuid, text[], text, text, text, text, text) from public, anon;
revoke all on function public.save_hotspot_plan(uuid, uuid, text, integer, numeric, numeric, numeric, text, integer, text, integer) from public, anon;
revoke all on function public.set_hotspot_plan_status(uuid, public.package_status) from public, anon;
revoke all on function public.sell_hotspot_voucher(uuid, uuid, text, text) from public, anon;
revoke all on function public.give_free_hotspot_voucher(uuid, uuid, text, text) from public, anon;
revoke all on function public.cancel_hotspot_voucher(uuid, text) from public, anon;
revoke all on function public.resend_hotspot_code_sms(uuid, text) from public, anon;
revoke all on function public.compensate_hotspot_outage(uuid, integer, text) from public, anon;
revoke all on function public.network_status(uuid) from public, anon;
revoke all on function public.hotspot_summary(uuid) from public, anon;
revoke all on function public.revenue_by_service(uuid, date, date, text) from public, anon;
grant execute on function public.save_service_settings(uuid, text[], text, text, text, text, text) to authenticated;
grant execute on function public.save_hotspot_plan(uuid, uuid, text, integer, numeric, numeric, numeric, text, integer, text, integer) to authenticated;
grant execute on function public.set_hotspot_plan_status(uuid, public.package_status) to authenticated;
grant execute on function public.sell_hotspot_voucher(uuid, uuid, text, text) to authenticated;
grant execute on function public.give_free_hotspot_voucher(uuid, uuid, text, text) to authenticated;
grant execute on function public.cancel_hotspot_voucher(uuid, text) to authenticated;
grant execute on function public.resend_hotspot_code_sms(uuid, text) to authenticated;
grant execute on function public.compensate_hotspot_outage(uuid, integer, text) to authenticated;
grant execute on function public.network_status(uuid) to authenticated;
grant execute on function public.hotspot_summary(uuid) to authenticated;
grant execute on function public.revenue_by_service(uuid, date, date, text) to authenticated;

-- The buying page is public (people buying WiFi are not signed in).
revoke all on function public.hotspot_portal(text) from public;
revoke all on function public.hotspot_portal_buy(text, uuid, text, text) from public;
revoke all on function public.hotspot_portal_status(text, uuid) from public;
revoke all on function public.hotspot_portal_simulate_payment(text, uuid) from public;
grant execute on function public.hotspot_portal(text) to anon, authenticated;
grant execute on function public.hotspot_portal_buy(text, uuid, text, text) to anon, authenticated;
grant execute on function public.hotspot_portal_status(text, uuid) to anon, authenticated;
grant execute on function public.hotspot_portal_simulate_payment(text, uuid) to anon, authenticated;

-- M-Pesa confirmation and SMS delivery: server-side only (service role).
revoke all on function public.set_hotspot_checkout(uuid, text) from public, anon, authenticated;
revoke all on function public.confirm_hotspot_payment(uuid, boolean, text, numeric, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.record_paybill_hotspot_payment(uuid, text, numeric, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.customer_sms_claim(integer) from public, anon, authenticated;
revoke all on function public.customer_sms_mark(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_hotspot_checkout(uuid, text) to service_role;
grant execute on function public.confirm_hotspot_payment(uuid, boolean, text, numeric, text, timestamptz, jsonb) to service_role;
grant execute on function public.record_paybill_hotspot_payment(uuid, text, numeric, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.customer_sms_claim(integer) to service_role;
grant execute on function public.customer_sms_mark(uuid, text, text) to service_role;
