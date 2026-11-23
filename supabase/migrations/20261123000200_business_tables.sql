-- =============================================================================
-- FibrePulse migration 0002: business tables
--
-- Customers, packages, subscriptions, billing, payments, network, support,
-- field operations, notifications and the FibrePulse commercial tables.
-- Screens for most of these arrive in later phases, but the tables and their
-- RLS policies exist from Phase 1 so tenant isolation is tested once, early.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enum types
-- -----------------------------------------------------------------------------
create type public.customer_status as enum ('active', 'suspended', 'pending_installation', 'disconnected', 'terminated');
create type public.billing_period as enum ('daily', 'weekly', 'monthly', 'custom');
create type public.package_status as enum ('active', 'inactive', 'archived');
create type public.subscription_status as enum ('pending', 'active', 'suspended', 'expired', 'cancelled');
create type public.subscription_change as enum ('new', 'renewal', 'upgrade', 'downgrade', 'restore');
create type public.revenue_category as enum ('subscription', 'installation', 'equipment', 'other');
create type public.invoice_status as enum ('draft', 'issued', 'partially_paid', 'paid', 'void');
-- No cash: the pilot ISP does not accept cash (decision 2026-11-23).
-- Add a value with `alter type ... add value` if a future tenant needs it.
create type public.payment_method as enum ('mpesa', 'bank_transfer', 'other');
create type public.payment_status as enum ('pending', 'successful', 'failed', 'cancelled', 'reversed', 'refunded');
create type public.verification_status as enum ('unverified', 'verified', 'rejected');
create type public.reconciliation_status as enum ('unreconciled', 'matched', 'unmatched', 'disputed');
create type public.reconciliation_result as enum ('matched', 'unmatched', 'disputed');
create type public.connector_status as enum ('pending', 'active', 'revoked');
create type public.device_status as enum ('online', 'offline', 'unknown');
create type public.session_type as enum ('pppoe', 'hotspot');
create type public.alert_severity as enum ('info', 'warning', 'critical');
create type public.alert_status as enum ('open', 'acknowledged', 'resolved');
create type public.ticket_category as enum ('no_internet', 'slow_internet', 'payment_issue', 'installation_request', 'subscription_issue', 'equipment_fault', 'general_enquiry');
create type public.ticket_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.ticket_status as enum ('open', 'assigned', 'in_progress', 'resolved', 'closed');
create type public.job_type as enum ('installation', 'maintenance', 'equipment_replacement', 'disconnection', 'fault_investigation');
create type public.job_status as enum ('scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled');
create type public.notification_channel as enum ('in_app', 'email', 'sms');
create type public.agreement_status as enum ('draft', 'active', 'superseded', 'terminated');
create type public.fee_basis as enum ('gross', 'net_of_vat');
create type public.fee_record_status as enum ('calculated', 'invoiced', 'void');
create type public.platform_invoice_status as enum ('draft', 'issued', 'paid', 'overdue', 'void');

-- =============================================================================
-- CUSTOMERS
-- =============================================================================
create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete restrict,
  customer_number text not null,
  full_name       text not null check (char_length(full_name) between 2 and 120),
  phone           text not null check (phone ~ '^\+254[17][0-9]{8}$'),
  email           extensions.citext,
  address         text,
  estate          text,
  town            text,
  county          text,
  status          public.customer_status not null default 'pending_installation',
  pppoe_username  text,
  registered_on   date not null default (now() at time zone 'Africa/Nairobi')::date,
  notes           text,
  data_source     public.data_source not null default 'manual',
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, customer_number)
);
-- Duplicate detection: one live customer per phone number per ISP.
create unique index customers_phone_unique on public.customers (tenant_id, phone) where status <> 'terminated';
create unique index customers_pppoe_unique on public.customers (tenant_id, pppoe_username) where pppoe_username is not null;
create index customers_tenant_status_idx on public.customers (tenant_id, status);
create index customers_tenant_area_idx on public.customers (tenant_id, county, town, estate);
create index customers_search_idx on public.customers using gin (to_tsvector('simple', full_name || ' ' || customer_number || ' ' || phone));

-- Exact GPS lives in its own table so it can carry stricter permissions
-- (Kenya Data Protection Act 2019: data minimisation).
create table public.customer_locations (
  customer_id uuid primary key,
  tenant_id   uuid not null,
  latitude    numeric(9, 6) not null check (latitude between -5.0 and 5.5),
  longitude   numeric(9, 6) not null check (longitude between 33.5 and 42.0),
  accuracy_m  numeric(8, 2),
  captured_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete cascade
);
comment on table public.customer_locations is 'Exact customer GPS. Bounded to Kenya. Visible only with customers:view_location or an assigned job.';

-- Assign customer numbers like FP-000123 when none is supplied.
create or replace function private.assign_customer_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
begin
  if new.customer_number is null or new.customer_number = '' then
    select customer_number_prefix into v_prefix from public.tenants where id = new.tenant_id;
    new.customer_number := v_prefix || '-' || lpad(private.next_tenant_number(new.tenant_id, 'customer')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger customers_number before insert on public.customers
  for each row execute function private.assign_customer_number();
create trigger customers_updated_at before update on public.customers
  for each row execute function private.set_updated_at();
create trigger customer_locations_updated_at before update on public.customer_locations
  for each row execute function private.set_updated_at();

-- =============================================================================
-- PACKAGES AND SUBSCRIPTIONS
-- =============================================================================
create table public.service_packages (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete restrict,
  name              text not null check (char_length(name) between 2 and 80),
  description       text,
  download_mbps     numeric(8, 2) not null check (download_mbps > 0),
  upload_mbps       numeric(8, 2) not null check (upload_mbps > 0),
  price             numeric(12, 2) not null check (price >= 0),
  billing_period    public.billing_period not null,
  -- Days of service per purchase. Daily = 1, weekly = 7, monthly = null
  -- (one calendar month), custom = required.
  duration_days     integer check (duration_days is null or duration_days between 1 and 366),
  data_limit_gb     numeric(10, 2) check (data_limit_gb is null or data_limit_gb > 0),
  fair_usage_policy text,
  network_profile   text,
  status            public.package_status not null default 'active',
  revenue_category  public.revenue_category not null default 'subscription',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  check (
    (billing_period = 'daily' and duration_days = 1) or
    (billing_period = 'weekly' and duration_days = 7) or
    (billing_period = 'monthly' and duration_days is null) or
    (billing_period = 'custom' and duration_days is not null)
  )
);
create trigger service_packages_updated_at before update on public.service_packages
  for each row execute function private.set_updated_at();

create table public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants (id) on delete restrict,
  customer_id              uuid not null,
  package_id               uuid not null,
  status                   public.subscription_status not null default 'pending',
  change_type              public.subscription_change not null default 'new',
  starts_at                timestamptz not null,
  expires_at               timestamptz not null,
  -- Price and period are copied at purchase so later package edits never
  -- rewrite history.
  price                    numeric(12, 2) not null check (price >= 0),
  billing_period           public.billing_period not null,
  previous_subscription_id uuid,
  suspended_at             timestamptz,
  suspension_reason        text,
  ended_at                 timestamptz,
  created_by               uuid references public.profiles (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (tenant_id, id),
  check (expires_at > starts_at),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete restrict,
  foreign key (tenant_id, package_id) references public.service_packages (tenant_id, id) on delete restrict,
  foreign key (tenant_id, previous_subscription_id) references public.subscriptions (tenant_id, id) on delete restrict
);
-- One live subscription per customer.
create unique index subscriptions_one_live on public.subscriptions (tenant_id, customer_id)
  where status in ('active', 'suspended');
create index subscriptions_expiry_idx on public.subscriptions (tenant_id, status, expires_at);
create index subscriptions_customer_idx on public.subscriptions (tenant_id, customer_id, starts_at desc);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function private.set_updated_at();

-- =============================================================================
-- INVOICES AND PAYMENTS
-- =============================================================================
create table public.invoices (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete restrict,
  invoice_number  text not null,
  customer_id     uuid not null,
  subscription_id uuid,
  issue_date      date not null default (now() at time zone 'Africa/Nairobi')::date,
  due_date        date not null,
  subtotal        numeric(14, 2) not null default 0 check (subtotal >= 0),
  tax_amount      numeric(14, 2) not null default 0 check (tax_amount >= 0),
  total           numeric(14, 2) not null default 0 check (total >= 0),
  amount_paid     numeric(14, 2) not null default 0 check (amount_paid >= 0),
  currency        char(3) not null default 'KES',
  status          public.invoice_status not null default 'draft',
  notes           text,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, invoice_number),
  check (total = subtotal + tax_amount),
  check (amount_paid <= total),
  check (due_date >= issue_date),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete restrict,
  foreign key (tenant_id, subscription_id) references public.subscriptions (tenant_id, id) on delete restrict
);
create index invoices_customer_idx on public.invoices (tenant_id, customer_id, issue_date desc);
create index invoices_open_idx on public.invoices (tenant_id, status) where status in ('issued', 'partially_paid');
create trigger invoices_updated_at before update on public.invoices
  for each row execute function private.set_updated_at();

create or replace function private.assign_invoice_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.invoice_number is null or new.invoice_number = '' then
    new.invoice_number := 'INV-' || lpad(private.next_tenant_number(new.tenant_id, 'invoice')::text, 6, '0');
  end if;
  return new;
end;
$$;
create trigger invoices_number before insert on public.invoices
  for each row execute function private.assign_invoice_number();

create table public.invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  invoice_id  uuid not null,
  description text not null check (char_length(description) between 1 and 200),
  category    public.revenue_category not null default 'subscription',
  quantity    numeric(10, 2) not null default 1 check (quantity > 0),
  unit_price  numeric(12, 2) not null check (unit_price >= 0),
  amount      numeric(14, 2) not null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  check (amount = round(quantity * unit_price, 2)),
  foreign key (tenant_id, invoice_id) references public.invoices (tenant_id, id) on delete cascade
);
create index invoice_lines_invoice_idx on public.invoice_lines (tenant_id, invoice_id);

create table public.payments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete restrict,
  -- Null while an incoming payment (e.g. a paybill deposit) is unmatched.
  customer_id           uuid,
  method                public.payment_method not null,
  -- M-Pesa receipt number, bank reference, etc. Used for duplicate detection.
  provider_reference    text check (provider_reference is null or char_length(provider_reference) between 4 and 64),
  amount                numeric(14, 2) not null check (amount > 0),
  currency              char(3) not null default 'KES',
  transaction_at        timestamptz not null,
  status                public.payment_status not null default 'pending',
  verification_status   public.verification_status not null default 'unverified',
  reconciliation_status public.reconciliation_status not null default 'unreconciled',
  revenue_category      public.revenue_category not null default 'subscription',
  data_source           public.data_source not null,
  payer_phone           text check (payer_phone is null or payer_phone ~ '^\+254[0-9]{9}$'),
  payer_name            text,
  description           text,
  invoice_reference     text,
  reversal_of           uuid,
  provider_payload      jsonb,
  recorded_by           uuid references public.profiles (id) on delete set null,
  verified_by           uuid references public.profiles (id) on delete set null,
  verified_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete restrict,
  foreign key (tenant_id, reversal_of) references public.payments (tenant_id, id) on delete restrict,
  -- Simulated payments can never be marked verified, so they can never be
  -- counted as collected revenue or feed the platform fee engine.
  constraint payments_simulated_never_verified check (data_source <> 'simulated' or verification_status <> 'verified'),
  -- A verified payment must record who or what verified it.
  constraint payments_verified_has_time check (verification_status <> 'verified' or verified_at is not null)
);
-- Duplicate transaction detection.
create unique index payments_reference_unique on public.payments (tenant_id, method, provider_reference)
  where provider_reference is not null;
create index payments_customer_idx on public.payments (tenant_id, customer_id, transaction_at desc);
create index payments_collected_idx on public.payments (tenant_id, transaction_at)
  where status = 'successful' and verification_status = 'verified';
create trigger payments_updated_at before update on public.payments
  for each row execute function private.set_updated_at();

-- Money facts never change after insert. Corrections are made by a reversal
-- payment row, so the history stays intact.
create or replace function private.guard_payment_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.tenant_id      is distinct from old.tenant_id
  or new.amount         is distinct from old.amount
  or new.currency       is distinct from old.currency
  or new.method         is distinct from old.method
  or new.provider_reference is distinct from old.provider_reference
  or new.transaction_at is distinct from old.transaction_at
  or new.data_source    is distinct from old.data_source
  or new.reversal_of    is distinct from old.reversal_of
  or new.recorded_by    is distinct from old.recorded_by then
    raise exception 'Payment amount, method, reference, date and source cannot be changed. Record a reversal instead.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger payments_immutable before update on public.payments
  for each row execute function private.guard_payment_immutable();

create table public.payment_allocations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  payment_id uuid not null,
  invoice_id uuid not null,
  amount     numeric(14, 2) not null check (amount > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (payment_id, invoice_id),
  foreign key (tenant_id, payment_id) references public.payments (tenant_id, id) on delete restrict,
  foreign key (tenant_id, invoice_id) references public.invoices (tenant_id, id) on delete restrict
);

-- Allocations may not exceed the payment amount or the invoice balance.
create or replace function private.guard_allocation_totals()
returns trigger
language plpgsql
as $$
declare
  v_payment_amount numeric(14, 2);
  v_allocated      numeric(14, 2);
  v_invoice_total  numeric(14, 2);
  v_invoice_alloc  numeric(14, 2);
begin
  select amount into v_payment_amount from public.payments where id = new.payment_id for update;
  select coalesce(sum(amount), 0) into v_allocated from public.payment_allocations where payment_id = new.payment_id;
  if v_allocated > v_payment_amount then
    raise exception 'Allocations (%) exceed payment amount (%)', v_allocated, v_payment_amount using errcode = 'check_violation';
  end if;
  select total into v_invoice_total from public.invoices where id = new.invoice_id for update;
  select coalesce(sum(amount), 0) into v_invoice_alloc from public.payment_allocations where invoice_id = new.invoice_id;
  if v_invoice_alloc > v_invoice_total then
    raise exception 'Allocations (%) exceed invoice total (%)', v_invoice_alloc, v_invoice_total using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger payment_allocations_totals
  after insert or update on public.payment_allocations
  deferrable initially immediate
  for each row execute function private.guard_allocation_totals();

create table public.payment_reconciliation_records (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  payment_id          uuid,
  statement_source    text not null check (statement_source in ('mpesa_statement', 'bank_statement', 'provider_query', 'manual_review')),
  statement_reference text,
  statement_amount    numeric(14, 2),
  statement_date      date,
  result              public.reconciliation_result not null,
  notes               text,
  matched_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, payment_id) references public.payments (tenant_id, id) on delete restrict
);
create index payment_reconciliation_payment_idx on public.payment_reconciliation_records (tenant_id, payment_id);

-- =============================================================================
-- NETWORK
-- =============================================================================
create table public.connector_agents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete restrict,
  name          text not null check (char_length(name) between 2 and 80),
  -- SHA-256 of the agent token. The token itself is shown once and never stored.
  token_hash    text not null unique,
  token_prefix  text not null,
  status        public.connector_status not null default 'pending',
  last_seen_at  timestamptz,
  agent_version text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create trigger connector_agents_updated_at before update on public.connector_agents
  for each row execute function private.set_updated_at();

create table public.routers (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete restrict,
  connector_agent_id uuid,
  name               text not null check (char_length(name) between 2 and 80),
  model              text,
  identity           text,
  serial_number      text,
  routeros_version   text,
  management_address inet,
  api_port           integer check (api_port is null or api_port between 1 and 65535),
  location_name      text,
  latitude           numeric(9, 6) check (latitude is null or latitude between -5.0 and 5.5),
  longitude          numeric(9, 6) check (longitude is null or longitude between 33.5 and 42.0),
  status             public.device_status not null default 'unknown',
  monitoring_enabled boolean not null default true,
  last_synced_at     timestamptz,
  last_sync_error    text,
  uptime_seconds     bigint check (uptime_seconds is null or uptime_seconds >= 0),
  cpu_load_pct       numeric(5, 2) check (cpu_load_pct is null or cpu_load_pct between 0 and 100),
  memory_used_pct    numeric(5, 2) check (memory_used_pct is null or memory_used_pct between 0 and 100),
  data_source        public.data_source not null default 'manual',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, connector_agent_id) references public.connector_agents (tenant_id, id) on delete set null (connector_agent_id)
);
create unique index routers_serial_unique on public.routers (tenant_id, serial_number) where serial_number is not null;
create trigger routers_updated_at before update on public.routers
  for each row execute function private.set_updated_at();

-- Router credentials: write-only for people. No RLS select policy exists, so
-- only the service role (connector ingest path) can read the ciphertext.
create table public.router_credentials (
  router_id         uuid primary key,
  tenant_id         uuid not null,
  username          text not null,
  secret_ciphertext text not null,
  key_version       integer not null default 1,
  updated_by        uuid references public.profiles (id) on delete set null,
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, router_id) references public.routers (tenant_id, id) on delete cascade
);
comment on table public.router_credentials is 'Encrypted read-only API credentials. Never selectable by app users; set via set_router_credentials().';

create table public.router_interfaces (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  router_id      uuid not null,
  name           text not null,
  interface_type text,
  mac_address    macaddr,
  running        boolean,
  disabled       boolean,
  rx_bps         bigint check (rx_bps is null or rx_bps >= 0),
  tx_bps         bigint check (tx_bps is null or tx_bps >= 0),
  last_seen_at   timestamptz,
  data_source    public.data_source not null default 'connector',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  unique (router_id, name),
  foreign key (tenant_id, router_id) references public.routers (tenant_id, id) on delete cascade
);
create trigger router_interfaces_updated_at before update on public.router_interfaces
  for each row execute function private.set_updated_at();

create table public.network_sessions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  router_id    uuid not null,
  customer_id  uuid,
  session_type public.session_type not null,
  username     text not null,
  ip_address   inet,
  caller_id    text,
  started_at   timestamptz not null,
  ended_at     timestamptz,
  last_seen_at timestamptz not null default now(),
  bytes_in     bigint not null default 0 check (bytes_in >= 0),
  bytes_out    bigint not null default 0 check (bytes_out >= 0),
  data_source  public.data_source not null default 'connector',
  unique (tenant_id, id),
  check (ended_at is null or ended_at >= started_at),
  foreign key (tenant_id, router_id) references public.routers (tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete set null (customer_id)
);
create index network_sessions_active_idx on public.network_sessions (tenant_id, router_id) where ended_at is null;
create index network_sessions_customer_idx on public.network_sessions (tenant_id, customer_id, started_at desc);

create table public.network_metrics (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null,
  router_id    uuid not null,
  interface_id uuid,
  metric       text not null check (metric in ('cpu_load_pct', 'memory_used_pct', 'uptime_seconds', 'rx_bps', 'tx_bps', 'active_sessions', 'reachable')),
  value        numeric not null,
  recorded_at  timestamptz not null,
  data_source  public.data_source not null default 'connector',
  foreign key (tenant_id, router_id) references public.routers (tenant_id, id) on delete cascade,
  foreign key (tenant_id, interface_id) references public.router_interfaces (tenant_id, id) on delete cascade
);
create index network_metrics_series_idx on public.network_metrics (tenant_id, router_id, metric, recorded_at desc);

create table public.network_alerts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete restrict,
  router_id       uuid,
  severity        public.alert_severity not null,
  alert_type      text not null,
  title           text not null,
  message         text,
  status          public.alert_status not null default 'open',
  opened_at       timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles (id) on delete set null,
  resolved_at     timestamptz,
  resolved_by     uuid references public.profiles (id) on delete set null,
  data_source     public.data_source not null default 'connector',
  unique (tenant_id, id),
  foreign key (tenant_id, router_id) references public.routers (tenant_id, id) on delete set null (router_id)
);
create index network_alerts_open_idx on public.network_alerts (tenant_id, severity, opened_at desc) where status <> 'resolved';

-- =============================================================================
-- SUPPORT AND FIELD OPERATIONS
-- =============================================================================
create table public.technicians (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  phone      text check (phone is null or phone ~ '^\+254[0-9]{9}$'),
  zone       text,
  skills     text[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, profile_id)
);
create trigger technicians_updated_at before update on public.technicians
  for each row execute function private.set_updated_at();

create table public.support_tickets (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  ticket_number    text not null,
  customer_id      uuid,
  category         public.ticket_category not null,
  priority         public.ticket_priority not null default 'medium',
  status           public.ticket_status not null default 'open',
  subject          text not null check (char_length(subject) between 3 and 160),
  description      text,
  assigned_to      uuid references public.profiles (id) on delete set null,
  resolution_notes text,
  resolved_at      timestamptz,
  closed_at        timestamptz,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, ticket_number),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete restrict
);
create index support_tickets_open_idx on public.support_tickets (tenant_id, status, priority);
create trigger support_tickets_updated_at before update on public.support_tickets
  for each row execute function private.set_updated_at();

create or replace function private.assign_ticket_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.ticket_number is null or new.ticket_number = '' then
    new.ticket_number := 'TKT-' || lpad(private.next_tenant_number(new.tenant_id, 'ticket')::text, 6, '0');
  end if;
  return new;
end;
$$;
create trigger support_tickets_number before insert on public.support_tickets
  for each row execute function private.assign_ticket_number();

create table public.installation_jobs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  job_number       text not null,
  customer_id      uuid,
  ticket_id        uuid,
  technician_id    uuid,
  job_type         public.job_type not null,
  status           public.job_status not null default 'scheduled',
  scheduled_for    timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  address          text,
  notes            text,
  completion_notes text,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, job_number),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete restrict,
  foreign key (tenant_id, ticket_id) references public.support_tickets (tenant_id, id) on delete set null (ticket_id),
  foreign key (tenant_id, technician_id) references public.technicians (tenant_id, id) on delete set null (technician_id)
);
create index installation_jobs_technician_idx on public.installation_jobs (tenant_id, technician_id, status);
create trigger installation_jobs_updated_at before update on public.installation_jobs
  for each row execute function private.set_updated_at();

create or replace function private.assign_job_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.job_number is null or new.job_number = '' then
    new.job_number := 'JOB-' || lpad(private.next_tenant_number(new.tenant_id, 'job')::text, 6, '0');
  end if;
  return new;
end;
$$;
create trigger installation_jobs_number before insert on public.installation_jobs
  for each row execute function private.assign_job_number();

-- =============================================================================
-- NOTIFICATIONS
-- =============================================================================
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references public.tenants (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  type         text not null check (type in (
                 'subscription_expiry', 'payment_confirmation', 'payment_failure', 'router_offline',
                 'network_outage', 'customer_complaint', 'installation_completion', 'critical_network_warning',
                 'staff_invitation', 'system')),
  title        text not null,
  body         text,
  link         text check (link is null or link ~ '^/'),
  channel      public.notification_channel not null default 'in_app',
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_inbox_idx on public.notifications (recipient_id, created_at desc) where read_at is null;

-- =============================================================================
-- FIBREPULSE COMMERCIAL PLATFORM
-- =============================================================================
create table public.commercial_agreements (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  version             integer not null check (version > 0),
  status              public.agreement_status not null default 'draft',
  -- 0.0275 = 2.75%. The ONLY place a fee rate is stored for a tenant.
  fee_rate            numeric(6, 4) not null default 0.0275 check (fee_rate > 0 and fee_rate < 1),
  fee_basis           public.fee_basis not null default 'gross',
  -- Categories that are NOT part of the fee base.
  excluded_categories public.revenue_category[] not null default '{installation,equipment,other}',
  effective_from      date not null,
  effective_to        date,
  signed_at           timestamptz,
  signed_by_name      text,
  notes               text,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, version),
  check (effective_to is null or effective_to > effective_from),
  check (status = 'draft' or signed_at is not null),
  -- Two agreements that are in force can never overlap in time.
  constraint commercial_agreements_no_overlap exclude using gist (
    tenant_id with =,
    daterange(effective_from, effective_to, '[)') with &&
  ) where (status in ('active', 'superseded'))
);
create trigger commercial_agreements_updated_at before update on public.commercial_agreements
  for each row execute function private.set_updated_at();

-- Once signed, the commercial terms are frozen. The only allowed changes are
-- closing the agreement (status -> superseded/terminated, setting effective_to).
create or replace function private.guard_agreement_terms()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' and (
       new.fee_rate            is distinct from old.fee_rate
    or new.fee_basis           is distinct from old.fee_basis
    or new.excluded_categories is distinct from old.excluded_categories
    or new.effective_from      is distinct from old.effective_from
    or new.tenant_id           is distinct from old.tenant_id
    or new.version             is distinct from old.version
    or new.signed_at           is distinct from old.signed_at
    or (old.effective_to is not null and new.effective_to is distinct from old.effective_to)
    or new.status = 'draft'
  ) then
    raise exception 'Signed commercial terms cannot be changed. Create a new agreement version.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger commercial_agreements_frozen before update on public.commercial_agreements
  for each row execute function private.guard_agreement_terms();

create table public.platform_invoices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete restrict,
  invoice_number    text not null unique,
  period_start      date not null,
  period_end        date not null,
  subtotal          numeric(14, 2) not null check (subtotal >= 0),
  tax_amount        numeric(14, 2) not null default 0 check (tax_amount >= 0),
  total             numeric(14, 2) not null,
  status            public.platform_invoice_status not null default 'draft',
  issued_at         timestamptz,
  due_date          date,
  paid_at           timestamptz,
  payment_reference text,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  check (period_end >= period_start),
  check (total = subtotal + tax_amount)
);
create trigger platform_invoices_updated_at before update on public.platform_invoices
  for each row execute function private.set_updated_at();

create table public.platform_fee_records (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  agreement_id        uuid not null,
  period_start        date not null,
  period_end          date not null,
  eligible_amount     numeric(14, 2) not null check (eligible_amount >= 0),
  -- Copied from the agreement at calculation time so history never changes.
  fee_rate            numeric(6, 4) not null,
  fee_amount          numeric(14, 2) not null,
  payment_count       integer not null default 0 check (payment_count >= 0),
  adjustment_of       uuid,
  reason              text,
  status              public.fee_record_status not null default 'calculated',
  platform_invoice_id uuid,
  calculated_by       uuid references public.profiles (id) on delete set null,
  calculated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  check (period_end >= period_start),
  check (adjustment_of is not null or fee_amount = round(eligible_amount * fee_rate, 2)),
  check (adjustment_of is null or reason is not null),
  foreign key (tenant_id, agreement_id) references public.commercial_agreements (tenant_id, id) on delete restrict,
  foreign key (tenant_id, adjustment_of) references public.platform_fee_records (tenant_id, id) on delete restrict,
  foreign key (tenant_id, platform_invoice_id) references public.platform_invoices (tenant_id, id) on delete restrict
);
-- A billing period is charged once. Corrections are adjustment rows.
create unique index platform_fee_records_once_per_period
  on public.platform_fee_records (tenant_id, period_start, period_end)
  where adjustment_of is null and status <> 'void';

-- =============================================================================
-- AUDIT TRIGGERS on sensitive business tables
-- =============================================================================
create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function private.audit_row_change();
create trigger subscriptions_audit after insert or update or delete on public.subscriptions
  for each row execute function private.audit_row_change();
create trigger invoices_audit after insert or update or delete on public.invoices
  for each row execute function private.audit_row_change();
create trigger payments_audit after insert or update or delete on public.payments
  for each row execute function private.audit_row_change();
create trigger payment_allocations_audit after insert or update or delete on public.payment_allocations
  for each row execute function private.audit_row_change();
create trigger payment_reconciliation_audit after insert or update or delete on public.payment_reconciliation_records
  for each row execute function private.audit_row_change();
create trigger service_packages_audit after insert or update or delete on public.service_packages
  for each row execute function private.audit_row_change();
create trigger routers_audit after insert or update or delete on public.routers
  for each row execute function private.audit_row_change();
create trigger connector_agents_audit after insert or update or delete on public.connector_agents
  for each row execute function private.audit_row_change();
create trigger commercial_agreements_audit after insert or update or delete on public.commercial_agreements
  for each row execute function private.audit_row_change();
create trigger platform_fee_records_audit after insert or update or delete on public.platform_fee_records
  for each row execute function private.audit_row_change();
create trigger platform_invoices_audit after insert or update or delete on public.platform_invoices
  for each row execute function private.audit_row_change();

-- Router credentials: audit that they changed, never what they are.
create or replace function private.audit_credential_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, reason)
  values (coalesce(new.tenant_id, old.tenant_id), auth.uid(), lower(tg_op), 'router_credentials',
          coalesce(new.router_id, old.router_id), 'credential value not logged');
  return coalesce(new, old);
end;
$$;
create trigger router_credentials_audit after insert or update or delete on public.router_credentials
  for each row execute function private.audit_credential_change();
