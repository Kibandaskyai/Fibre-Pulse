-- =============================================================================
-- FibrePulse migration 0007: revenue and financial analytics (Phase 3)
--
-- Read-only reporting functions. They run as SECURITY INVOKER, so Row Level
-- Security still applies to every row they read, and each one also requires
-- the revenue:view permission in the tenant.
--
-- Definitions used everywhere (spec Module 4 and 5):
--   * Collected  = payments with status 'successful' AND verification
--                  'verified', dated by the transaction time in the ISP's
--                  time zone. Pending, unverified, rejected, failed and
--                  simulated payments are never collected revenue.
--   * Awaiting verification = successful but unverified payments.
--   * Reversed / refunded   = payments now in those statuses.
--   * Recognised = the part of collected payments applied to invoices
--                  (the rest is customer credit not yet earned).
--   * Outstanding = unpaid balance of issued and part-paid invoices.
--   * Area filter  matches a customer's county, town or estate (any case).
-- =============================================================================

create or replace function private.require_revenue_view(p_tenant uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_tenant is null or not private.has_permission(p_tenant, 'revenue:view') then
    raise exception 'You do not have permission to view revenue.' using errcode = 'insufficient_privilege';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  return coalesce(v_tz, 'Africa/Nairobi');
end;
$$;
grant execute on function private.require_revenue_view(uuid) to authenticated;

-- True when the customer is in the requested area (or no area was asked for).
create or replace function private.in_area(p_customer uuid, p_area text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select p_area is null or trim(p_area) = '' or exists (
    select 1 from public.customers c
    where c.id = p_customer
      and lower(trim(p_area)) in (lower(coalesce(c.county, '')), lower(coalesce(c.town, '')), lower(coalesce(c.estate, '')))
  )
$$;
grant execute on function private.in_area(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Headline figures for a date range, plus fixed today / this week / this month
-- windows for the dashboard. Weeks start on Monday.
-- -----------------------------------------------------------------------------
create or replace function public.revenue_kpis(p_tenant uuid, p_from date, p_to date, p_area text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz    text := private.require_revenue_view(p_tenant);
  v_today date := (now() at time zone v_tz)::date;
  v_out   jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception 'Choose a valid date range (at most 10 years).' using errcode = 'check_violation';
  end if;

  with pay as (
    select p.*, (p.transaction_at at time zone v_tz)::date as local_date
    from public.payments p
    where p.tenant_id = p_tenant
      and (p_area is null or trim(p_area) = '' or (p.customer_id is not null and private.in_area(p.customer_id, p_area)))
  ),
  collected as (
    select * from pay where status = 'successful' and verification_status = 'verified'
  ),
  in_range as (
    select * from collected where local_date between p_from and p_to
  ),
  applied as (
    select coalesce(sum(a.amount), 0) as amount
    from public.payment_allocations a
    join in_range r on r.id = a.payment_id
  ),
  open_invoices as (
    select i.* from public.invoices i
    where i.tenant_id = p_tenant and i.status in ('issued', 'partially_paid')
      and private.in_area(i.customer_id, p_area)
  ),
  subs as (
    select s.change_type from public.subscriptions s
    where s.tenant_id = p_tenant
      and (s.created_at at time zone v_tz)::date between p_from and p_to
      and private.in_area(s.customer_id, p_area)
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'today', v_today,
    'collected', (select coalesce(sum(amount), 0) from in_range),
    'collected_count', (select count(*) from in_range),
    'collected_mpesa', (select coalesce(sum(amount), 0) from in_range where method = 'mpesa'),
    'collected_bank', (select coalesce(sum(amount), 0) from in_range where method = 'bank_transfer'),
    'collected_other', (select coalesce(sum(amount), 0) from in_range where method = 'other'),
    'recognised', (select amount from applied),
    'unapplied_credit', (select coalesce(sum(amount), 0) from in_range) - (select amount from applied),
    'paying_customers', (select count(distinct customer_id) from in_range where customer_id is not null),
    'awaiting_verification', (select coalesce(sum(amount), 0) from pay where status = 'successful' and verification_status = 'unverified' and local_date between p_from and p_to and data_source <> 'simulated'),
    'awaiting_verification_count', (select count(*) from pay where status = 'successful' and verification_status = 'unverified' and local_date between p_from and p_to and data_source <> 'simulated'),
    'simulated_excluded', (select coalesce(sum(amount), 0) from pay where data_source = 'simulated' and local_date between p_from and p_to),
    'simulated_excluded_count', (select count(*) from pay where data_source = 'simulated' and local_date between p_from and p_to),
    'reversed', (select coalesce(sum(amount), 0) from pay where status = 'reversed' and local_date between p_from and p_to),
    'reversed_count', (select count(*) from pay where status = 'reversed' and local_date between p_from and p_to),
    'refunded', (select coalesce(sum(amount), 0) from pay where status = 'refunded' and local_date between p_from and p_to),
    'refunded_count', (select count(*) from pay where status = 'refunded' and local_date between p_from and p_to),
    'outstanding', (select coalesce(sum(total - amount_paid), 0) from open_invoices),
    'outstanding_customers', (select count(distinct customer_id) from open_invoices),
    'overdue', (select coalesce(sum(total - amount_paid), 0) from open_invoices where due_date < v_today),
    'invoiced', (select coalesce(sum(i.total), 0) from public.invoices i
                 where i.tenant_id = p_tenant and i.status <> 'void' and i.issue_date between p_from and p_to
                   and private.in_area(i.customer_id, p_area)),
    'new_subscriptions', (select count(*) from subs where change_type = 'new'),
    'renewals', (select count(*) from subs where change_type = 'renewal'),
    'upgrades', (select count(*) from subs where change_type = 'upgrade'),
    'downgrades', (select count(*) from subs where change_type = 'downgrade'),
    'collected_today', (select coalesce(sum(amount), 0) from collected where local_date = v_today),
    'collected_this_week', (select coalesce(sum(amount), 0) from collected where local_date >= v_today - (extract(isodow from v_today)::int - 1)),
    'collected_this_month', (select coalesce(sum(amount), 0) from collected where local_date >= date_trunc('month', v_today)::date)
  ) into v_out;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- Collections per day or per month, with empty periods filled with zero.
-- -----------------------------------------------------------------------------
create or replace function public.revenue_series(p_tenant uuid, p_from date, p_to date, p_grain text default 'day', p_area text default null)
returns table (bucket date, collected numeric, payments integer, reversed numeric)
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
    select date_trunc(p_grain, (p.transaction_at at time zone v_tz))::date as b, p.amount, p.status, p.verification_status
    from public.payments p
    where p.tenant_id = p_tenant
      and (p.transaction_at at time zone v_tz)::date between p_from and p_to
      and (p_area is null or trim(p_area) = '' or (p.customer_id is not null and private.in_area(p.customer_id, p_area)))
  )
  select bk.b,
         coalesce(sum(pay.amount) filter (where pay.status = 'successful' and pay.verification_status = 'verified'), 0)::numeric,
         (count(pay.amount) filter (where pay.status = 'successful' and pay.verification_status = 'verified'))::integer,
         coalesce(sum(pay.amount) filter (where pay.status = 'reversed'), 0)::numeric
  from buckets bk
  left join pay on pay.b = bk.b
  group by bk.b
  order by bk.b;
end;
$$;

-- -----------------------------------------------------------------------------
-- Collections split by package, area or method.
-- By package: money is followed through allocations to the invoice and the
-- subscription it was for. Unapplied money and one-off charges get their own
-- rows, so the rows always add up to the collected total.
-- -----------------------------------------------------------------------------
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
  if p_dimension not in ('package', 'area', 'method') then
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

  elsif p_dimension = 'area' then
    return query
    select coalesce(nullif(c.estate, ''), nullif(c.town, ''), nullif(c.county, ''), case when p.customer_id is null then 'Not linked to a customer' else 'No area recorded' end),
           sum(p.amount)::numeric, count(*)::integer
    from public.payments p
    left join public.customers c on c.id = p.customer_id
    where p.tenant_id = p_tenant and p.status = 'successful' and p.verification_status = 'verified'
      and (p.transaction_at at time zone v_tz)::date between p_from and p_to
      and (p_area is null or trim(p_area) = '' or (p.customer_id is not null and private.in_area(p.customer_id, p_area)))
    group by 1 order by 2 desc;

  else
    return query
    with pay as (
      select p.id, p.amount
      from public.payments p
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
      from pay
    )
    select x.lbl, sum(x.amount)::numeric, count(distinct x.payment_id)::integer
    from (
      select alloc.lbl, alloc.amount, alloc.payment_id from alloc
      union all
      select 'Credit not yet applied to an invoice', u.amount, u.id from unapplied u where u.amount > 0
    ) x
    group by 1 order by 2 desc;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Live subscriptions per package, with the monthly-equivalent value.
-- Needs subscriptions:view (customers' package mix is not a money figure).
-- -----------------------------------------------------------------------------
create or replace function public.subscription_distribution(p_tenant uuid, p_area text default null)
returns table (package text, active integer, suspended integer, monthly_value numeric)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.has_permission(p_tenant, 'subscriptions:view') then
    raise exception 'You do not have permission to view subscriptions.' using errcode = 'insufficient_privilege';
  end if;
  return query
  select sp.name,
         (count(*) filter (where s.status = 'active'))::integer,
         (count(*) filter (where s.status = 'suspended'))::integer,
         round(sum(case s.billing_period
                     when 'monthly' then s.price
                     when 'weekly' then s.price * 30.4375 / 7
                     when 'daily' then s.price * 30.4375
                     else s.price * 30.4375 / greatest(coalesce(sp.duration_days, 30), 1)
                   end) filter (where s.status = 'active'), 2)
  from public.subscriptions s
  join public.service_packages sp on sp.id = s.package_id
  where s.tenant_id = p_tenant and s.status in ('active', 'suspended')
    and private.in_area(s.customer_id, p_area)
  group by sp.name
  order by 2 desc, 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- New customers per month and the running total (customer growth).
-- Needs customers:view.
-- -----------------------------------------------------------------------------
create or replace function public.customer_growth(p_tenant uuid, p_months integer default 12, p_area text default null)
returns table (month date, new_customers integer, total_customers integer)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
  v_first date;
begin
  if not private.has_permission(p_tenant, 'customers:view') then
    raise exception 'You do not have permission to view customers.' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(timezone, 'Africa/Nairobi') into v_tz from public.tenants where id = p_tenant;
  v_first := (date_trunc('month', (now() at time zone v_tz)) - make_interval(months => greatest(least(p_months, 60), 1) - 1))::date;
  return query
  with m as (
    select gs::date as mo from generate_series(v_first::timestamp, date_trunc('month', now() at time zone v_tz), interval '1 month') gs
  ),
  c as (
    select date_trunc('month', cu.registered_on::timestamp)::date as mo
    from public.customers cu
    where cu.tenant_id = p_tenant and cu.status <> 'terminated'
      and (p_area is null or trim(p_area) = '' or lower(trim(p_area)) in (lower(coalesce(cu.county, '')), lower(coalesce(cu.town, '')), lower(coalesce(cu.estate, ''))))
  )
  select m.mo,
         (select count(*) from c where c.mo = m.mo)::integer,
         (select count(*) from c where c.mo <= m.mo)::integer
  from m order by m.mo;
end;
$$;

-- -----------------------------------------------------------------------------
-- Outstanding invoices by how long they are past due (in the ISP's time zone).
-- -----------------------------------------------------------------------------
create or replace function public.outstanding_ageing(p_tenant uuid, p_area text default null)
returns table (bucket text, sort_order integer, invoices integer, customers integer, amount numeric)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text := private.require_revenue_view(p_tenant);
  v_today date := (now() at time zone v_tz)::date;
begin
  return query
  with b(bucket, sort_order) as (
    values ('Not yet due', 0), ('1–30 days overdue', 1), ('31–60 days overdue', 2), ('61–90 days overdue', 3), ('Over 90 days overdue', 4)
  ),
  inv as (
    select i.customer_id, i.total - i.amount_paid as due,
           case
             when i.due_date >= v_today then 0
             when v_today - i.due_date <= 30 then 1
             when v_today - i.due_date <= 60 then 2
             when v_today - i.due_date <= 90 then 3
             else 4
           end as so
    from public.invoices i
    where i.tenant_id = p_tenant and i.status in ('issued', 'partially_paid')
      and private.in_area(i.customer_id, p_area)
  )
  select b.bucket, b.sort_order,
         (count(inv.due))::integer,
         (count(distinct inv.customer_id))::integer,
         coalesce(sum(inv.due), 0)::numeric
  from b left join inv on inv.so = b.sort_order
  group by b.bucket, b.sort_order
  order by b.sort_order;
end;
$$;

-- Areas used by this ISP's customers, for filter dropdowns.
create or replace function public.customer_areas(p_tenant uuid)
returns table (area text, kind text, customers integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select v.area, v.kind, count(*)::integer
  from public.customers c
  cross join lateral (values (c.county, 'county'), (c.town, 'town'), (c.estate, 'estate')) as v(area, kind)
  where c.tenant_id = p_tenant and c.status <> 'terminated' and coalesce(trim(v.area), '') <> ''
  group by v.area, v.kind
  order by 3 desc, 1
  limit 300
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.revenue_kpis(uuid, date, date, text)',
    'public.revenue_series(uuid, date, date, text, text)',
    'public.revenue_breakdown(uuid, date, date, text, text)',
    'public.subscription_distribution(uuid, text)',
    'public.customer_growth(uuid, integer, text)',
    'public.outstanding_ageing(uuid, text)',
    'public.customer_areas(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
