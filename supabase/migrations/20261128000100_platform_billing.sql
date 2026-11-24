-- =============================================================================
-- FibrePulse migration: commercial platform (Phase 6)
--
--   * Commercial agreements: drafts, signing (which supersedes the previous
--     version), ending. Agreements start on the first day of a month so each
--     billing month has exactly one agreement and one fee rate.
--   * Fee engine: per ISP per month, eligible = verified, successful, real
--     payments dated in the month (ISP time zone) whose category the agreement
--     does not exclude; net_of_vat divides by 1.16. The rate is copied onto the
--     record. Recalculating never edits a record: a difference becomes an
--     adjustment row, so history and duplicates are impossible to lose.
--   * Platform invoices: collect every calculated, uninvoiced fee record of
--     an ISP; record payment; void (which releases the fee records).
--   * Platform analytics for super administrators (aggregates only).
--   * Support access: request, approve/decline/revoke, listing.
--
-- All writes to commercial tables go through these SECURITY DEFINER
-- functions; the direct write policies are removed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table changes and guards
-- -----------------------------------------------------------------------------
-- Adjustments can reduce the base (a reversal after the fee was charged).
alter table public.platform_fee_records drop constraint platform_fee_records_eligible_amount_check;
alter table public.platform_fee_records add constraint platform_fee_records_eligible_amount_check
  check (eligible_amount >= 0 or adjustment_of is not null);

alter table public.platform_invoices add column notes text;
alter table public.platform_invoices add column void_reason text;
alter table public.platform_invoices add column tax_rate numeric(5, 4) not null default 0 check (tax_rate >= 0 and tax_rate < 0.5);

drop policy if exists commercial_agreements_insert on public.commercial_agreements;
drop policy if exists commercial_agreements_update on public.commercial_agreements;
drop policy if exists platform_fee_records_insert on public.platform_fee_records;
drop policy if exists platform_fee_records_update on public.platform_fee_records;
drop policy if exists platform_invoices_insert on public.platform_invoices;
drop policy if exists platform_invoices_update on public.platform_invoices;

-- Fee calculations are permanent. Only the invoice link and status move.
create or replace function private.guard_fee_record()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Fee calculations cannot be deleted.' using errcode = 'check_violation';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.agreement_id is distinct from old.agreement_id
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.eligible_amount is distinct from old.eligible_amount
     or new.fee_rate is distinct from old.fee_rate
     or new.fee_amount is distinct from old.fee_amount
     or new.payment_count is distinct from old.payment_count
     or new.adjustment_of is distinct from old.adjustment_of
     or new.reason is distinct from old.reason
     or new.calculated_at is distinct from old.calculated_at
     or new.calculated_by is distinct from old.calculated_by
     or old.status = 'void' then
    raise exception 'Fee calculations cannot be edited. Recalculate the month to add an adjustment.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger platform_fee_records_frozen before update or delete on public.platform_fee_records
  for each row execute function private.guard_fee_record();

-- Issued invoices keep their amounts; only status, payment and void fields move.
create or replace function private.guard_platform_invoice()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Platform invoices cannot be deleted. Void them instead.' using errcode = 'check_violation';
  end if;
  if old.status in ('paid', 'void') and new.status is distinct from old.status then
    raise exception 'A paid or void invoice cannot change.' using errcode = 'check_violation';
  end if;
  if new.subtotal is distinct from old.subtotal or new.tax_amount is distinct from old.tax_amount
     or new.total is distinct from old.total or new.invoice_number is distinct from old.invoice_number
     or new.tenant_id is distinct from old.tenant_id or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end or new.tax_rate is distinct from old.tax_rate then
    raise exception 'Invoice amounts cannot be changed. Void it and issue a new one.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger platform_invoices_frozen before update or delete on public.platform_invoices
  for each row execute function private.guard_platform_invoice();

create sequence if not exists private.platform_invoice_seq;

create or replace function private.require_platform_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Only FibrePulse super administrators can do this.' using errcode = 'insufficient_privilege';
  end if;
end;
$$;
grant execute on function private.require_platform_admin() to authenticated;

create or replace function private.tenant_tz(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$ select coalesce((select timezone from public.tenants where id = p_tenant), 'Africa/Nairobi') $$;

-- -----------------------------------------------------------------------------
-- Commercial agreements
-- -----------------------------------------------------------------------------
create or replace function private.check_agreement_terms(p_fee_rate numeric, p_excluded public.revenue_category[], p_effective_from date)
returns void
language plpgsql
immutable
as $$
begin
  if p_fee_rate is null or p_fee_rate <= 0 or p_fee_rate > 0.2 then
    raise exception 'The fee rate must be more than 0%% and at most 20%%.' using errcode = 'check_violation';
  end if;
  if p_fee_rate <> round(p_fee_rate, 4) then
    raise exception 'Use at most two decimal places in the percentage (for example 2.75%%).' using errcode = 'check_violation';
  end if;
  if 'subscription' = any(coalesce(p_excluded, '{}')) then
    raise exception 'Subscription collections are always part of the fee base.' using errcode = 'check_violation';
  end if;
  if p_effective_from is null or extract(day from p_effective_from) <> 1 then
    raise exception 'Agreements start on the first day of a month.' using errcode = 'check_violation';
  end if;
end;
$$;

-- Create a new draft (p_agreement null) or change an existing draft.
create or replace function public.admin_save_agreement(
  p_tenant uuid, p_agreement uuid, p_fee_rate numeric, p_fee_basis public.fee_basis,
  p_excluded public.revenue_category[], p_effective_from date, p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status public.agreement_status;
begin
  perform private.require_platform_admin();
  perform private.check_agreement_terms(p_fee_rate, p_excluded, p_effective_from);
  if not exists (select 1 from public.tenants where id = p_tenant) then
    raise exception 'ISP not found.' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.commercial_agreements a where a.tenant_id = p_tenant
             and a.status in ('active', 'superseded', 'terminated') and a.effective_from >= p_effective_from) then
    raise exception 'A signed agreement already starts on or after that date. Choose a later month.' using errcode = 'check_violation';
  end if;

  if p_agreement is null then
    if exists (select 1 from public.commercial_agreements where tenant_id = p_tenant and status = 'draft') then
      raise exception 'This ISP already has a draft agreement. Change or discard it first.' using errcode = 'check_violation';
    end if;
    insert into public.commercial_agreements (tenant_id, version, status, fee_rate, fee_basis, excluded_categories, effective_from, notes, created_by)
    values (p_tenant,
            coalesce((select max(version) from public.commercial_agreements where tenant_id = p_tenant), 0) + 1,
            'draft', p_fee_rate, coalesce(p_fee_basis, 'gross'), coalesce(p_excluded, '{}'), p_effective_from,
            nullif(left(trim(coalesce(p_notes, '')), 1000), ''), auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select status into v_status from public.commercial_agreements where id = p_agreement and tenant_id = p_tenant for update;
  if not found then
    raise exception 'Agreement not found.' using errcode = 'no_data_found';
  end if;
  if v_status <> 'draft' then
    raise exception 'Signed commercial terms cannot be changed. Create a new agreement version.' using errcode = 'check_violation';
  end if;
  update public.commercial_agreements
  set fee_rate = p_fee_rate, fee_basis = coalesce(p_fee_basis, 'gross'), excluded_categories = coalesce(p_excluded, '{}'),
      effective_from = p_effective_from, notes = nullif(left(trim(coalesce(p_notes, '')), 1000), '')
  where id = p_agreement;
  return p_agreement;
end;
$$;

create or replace function public.admin_discard_agreement(p_agreement uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  delete from public.commercial_agreements where id = p_agreement and status = 'draft';
  if not found then
    raise exception 'Only a draft agreement can be discarded.' using errcode = 'check_violation';
  end if;
end;
$$;

-- Sign a draft. The previous open-ended agreement ends the day before.
create or replace function public.admin_sign_agreement(p_agreement uuid, p_signed_by text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.commercial_agreements;
begin
  perform private.require_platform_admin();
  select * into a from public.commercial_agreements where id = p_agreement for update;
  if not found or a.status <> 'draft' then
    raise exception 'Only a draft agreement can be signed.' using errcode = 'check_violation';
  end if;
  if p_signed_by is null or char_length(trim(p_signed_by)) < 3 then
    raise exception 'Enter the name of the person who signed for the ISP.' using errcode = 'check_violation';
  end if;
  perform private.check_agreement_terms(a.fee_rate, a.excluded_categories, a.effective_from);
  if exists (select 1 from public.commercial_agreements x where x.tenant_id = a.tenant_id
             and x.status in ('active', 'superseded', 'terminated') and x.effective_from >= a.effective_from) then
    raise exception 'A signed agreement already starts on or after this one. Change the start month.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.platform_fee_records f where f.tenant_id = a.tenant_id and f.period_start >= a.effective_from and f.status <> 'void') then
    raise exception 'Fees from % onward are already calculated under the current agreement. Start the new agreement after the last calculated month.',
      to_char(a.effective_from, 'FMMonth YYYY') using errcode = 'check_violation';
  end if;

  perform set_config('fibrepulse.audit_reason', 'Agreement version ' || a.version || ' signed by ' || left(trim(p_signed_by), 120), true);
  update public.commercial_agreements
  set status = 'superseded', effective_to = a.effective_from
  where tenant_id = a.tenant_id and status = 'active' and effective_from < a.effective_from
    and (effective_to is null or effective_to > a.effective_from);

  update public.commercial_agreements
  set status = 'active', signed_at = now(), signed_by_name = left(trim(p_signed_by), 120)
  where id = a.id;
end;
$$;

-- End the agreement in force from p_end (first day of a month; no fees from then).
create or replace function public.admin_end_agreement(p_agreement uuid, p_end date, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.commercial_agreements;
begin
  perform private.require_platform_admin();
  select * into a from public.commercial_agreements where id = p_agreement for update;
  if not found or a.status <> 'active' or a.effective_to is not null then
    raise exception 'Only the agreement currently in force can be ended.' using errcode = 'check_violation';
  end if;
  if p_end is null or extract(day from p_end) <> 1 or p_end <= a.effective_from then
    raise exception 'The end date must be the first day of a month after the agreement started.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.platform_fee_records f where f.agreement_id = a.id and f.period_start >= p_end and f.status <> 'void') then
    raise exception 'Fees are already calculated after that date.' using errcode = 'check_violation';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  perform set_config('fibrepulse.audit_reason', left(trim(p_reason), 500), true);
  update public.commercial_agreements set status = 'terminated', effective_to = p_end where id = a.id;
end;
$$;

-- The signed agreement that applies to a month (first day), if any.
create or replace function private.agreement_for_month(p_tenant uuid, p_month date)
returns public.commercial_agreements
language sql
stable
security definer
set search_path = ''
as $$
  select a.* from public.commercial_agreements a
  where a.tenant_id = p_tenant and a.status in ('active', 'superseded', 'terminated')
    and a.effective_from <= p_month and (a.effective_to is null or a.effective_to > p_month)
  order by a.version desc limit 1
$$;

-- -----------------------------------------------------------------------------
-- Fee engine
-- -----------------------------------------------------------------------------
create or replace function private.fee_base(p_tenant uuid, p_from date, p_to date, p_basis public.fee_basis, p_excluded public.revenue_category[])
returns table (amount numeric, payments integer)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when p_basis = 'net_of_vat' then round(p.amount / 1.16, 2) else p.amount end), 0)::numeric,
         count(*)::integer
  from public.payments p
  where p.tenant_id = p_tenant
    and p.status = 'successful' and p.verification_status = 'verified' and p.data_source <> 'simulated'
    and not (p.revenue_category = any(coalesce(p_excluded, '{}')))
    and (p.transaction_at at time zone private.tenant_tz(p_tenant))::date between p_from and p_to
$$;

create or replace function public.admin_calculate_fees(p_tenant uuid, p_month date)
returns table (result text, fee_record_id uuid, period_start date, eligible_amount numeric, fee_amount numeric,
               payment_count integer, fee_rate numeric, agreement_version integer, total_eligible numeric, total_fee numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  a public.commercial_agreements;
  v_base public.platform_fee_records;
  v_amount numeric;
  v_count integer;
  v_prev_e numeric;
  v_prev_f numeric;
  v_new_f numeric;
  v_id uuid;
begin
  perform private.require_platform_admin();
  if p_month is null then
    raise exception 'Choose a month.' using errcode = 'check_violation';
  end if;
  if v_end >= (now() at time zone private.tenant_tz(p_tenant))::date then
    raise exception 'Fees for % can be calculated once the month has ended.', to_char(v_start, 'FMMonth YYYY') using errcode = 'check_violation';
  end if;
  a := private.agreement_for_month(p_tenant, v_start);
  if a.id is null then
    raise exception 'No signed agreement covers %. Sign an agreement first.', to_char(v_start, 'FMMonth YYYY') using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtext('fee:' || p_tenant::text || v_start::text));

  select f.* into v_base from public.platform_fee_records f
  where f.tenant_id = p_tenant and f.period_start = v_start and f.period_end = v_end
    and f.adjustment_of is null and f.status <> 'void';

  if v_base.id is null then
    select b.amount, b.payments into v_amount, v_count from private.fee_base(p_tenant, v_start, v_end, a.fee_basis, a.excluded_categories) b;
    insert into public.platform_fee_records (tenant_id, agreement_id, period_start, period_end, eligible_amount, fee_rate, fee_amount, payment_count, calculated_by)
    values (p_tenant, a.id, v_start, v_end, v_amount, a.fee_rate, round(v_amount * a.fee_rate, 2), v_count, auth.uid())
    returning id into v_id;
    return query select 'calculated'::text, v_id, v_start, v_amount, round(v_amount * a.fee_rate, 2), v_count, a.fee_rate, a.version, v_amount, round(v_amount * a.fee_rate, 2);
    return;
  end if;

  -- Recalculate with the terms the month was first charged under.
  select * into a from public.commercial_agreements where id = v_base.agreement_id;
  select b.amount, b.payments into v_amount, v_count from private.fee_base(p_tenant, v_start, v_end, a.fee_basis, a.excluded_categories) b;
  select coalesce(sum(f.eligible_amount), 0), coalesce(sum(f.fee_amount), 0) into v_prev_e, v_prev_f
  from public.platform_fee_records f where (f.id = v_base.id or f.adjustment_of = v_base.id) and f.status <> 'void';

  if v_prev_e = v_amount then
    return query select 'unchanged'::text, v_base.id, v_start, 0::numeric, 0::numeric, v_count, v_base.fee_rate, a.version, v_prev_e, v_prev_f;
    return;
  end if;

  v_new_f := round(v_amount * v_base.fee_rate, 2);
  insert into public.platform_fee_records (tenant_id, agreement_id, period_start, period_end, eligible_amount, fee_rate, fee_amount,
                                           payment_count, adjustment_of, reason, calculated_by)
  values (p_tenant, v_base.agreement_id, v_start, v_end, v_amount - v_prev_e, v_base.fee_rate, v_new_f - v_prev_f, v_count, v_base.id,
          format('Recalculated %s: eligible collections changed from KSh %s to KSh %s (late verifications, reversals or refunds).',
                 to_char(now() at time zone private.tenant_tz(p_tenant), 'DD Mon YYYY'),
                 to_char(v_prev_e, 'FM999,999,999,990.00'), to_char(v_amount, 'FM999,999,999,990.00')),
          auth.uid())
  returning id into v_id;
  return query select 'adjustment'::text, v_id, v_start, v_amount - v_prev_e, v_new_f - v_prev_f, v_count, v_base.fee_rate, a.version, v_amount, v_new_f;
end;
$$;

-- Run the month for every ISP with an agreement covering it.
create or replace function public.admin_calculate_all_fees(p_month date)
returns table (tenant_id uuid, tenant_name text, result text, total_eligible numeric, total_fee numeric, message text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  r record;
begin
  perform private.require_platform_admin();
  for t in select id, name from public.tenants where status in ('active', 'suspended') order by name loop
    if (private.agreement_for_month(t.id, date_trunc('month', p_month)::date)).id is null then
      return query select t.id, t.name, 'no_agreement'::text, null::numeric, null::numeric, 'No signed agreement for this month.'::text;
      continue;
    end if;
    begin
      select * into r from public.admin_calculate_fees(t.id, p_month) limit 1;
      return query select t.id, t.name, r.result, r.total_eligible, r.total_fee, null::text;
    exception when check_violation then
      return query select t.id, t.name, 'error'::text, null::numeric, null::numeric, sqlerrm;
    end;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Platform invoices
-- -----------------------------------------------------------------------------
create or replace function public.admin_issue_platform_invoice(p_tenant uuid, p_due_days integer, p_tax_rate numeric, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sum numeric;
  v_count integer;
  v_from date;
  v_to date;
  v_tax numeric;
  v_id uuid;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
begin
  perform private.require_platform_admin();
  if p_due_days is null or p_due_days < 1 or p_due_days > 90 then
    raise exception 'Payment terms must be between 1 and 90 days.' using errcode = 'check_violation';
  end if;
  if p_tax_rate is null or p_tax_rate < 0 or p_tax_rate >= 0.5 then
    raise exception 'Enter a valid VAT rate (0 if FibrePulse does not charge VAT).' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtext('platform-invoice:' || p_tenant::text));
  select coalesce(sum(f.fee_amount), 0), count(*), min(f.period_start), max(f.period_end)
  into v_sum, v_count, v_from, v_to
  from public.platform_fee_records f
  where f.tenant_id = p_tenant and f.status = 'calculated' and f.platform_invoice_id is null;
  if v_count = 0 then
    raise exception 'There are no calculated fees waiting to be invoiced for this ISP.' using errcode = 'check_violation';
  end if;
  if v_sum <= 0 then
    raise exception 'The fees waiting to be invoiced come to KSh % or less, so there is nothing to bill yet. They will be included in the next invoice.', to_char(v_sum, 'FM999,999,990.00') using errcode = 'check_violation';
  end if;
  v_tax := round(v_sum * p_tax_rate, 2);
  insert into public.platform_invoices (tenant_id, invoice_number, period_start, period_end, subtotal, tax_amount, tax_rate, total,
                                        status, issued_at, due_date, notes, created_by)
  values (p_tenant, 'FP-' || to_char(v_today, 'YYYY') || '-' || lpad(nextval('private.platform_invoice_seq')::text, 5, '0'),
          v_from, v_to, v_sum, v_tax, p_tax_rate, v_sum + v_tax, 'issued', now(), v_today + p_due_days,
          nullif(left(trim(coalesce(p_notes, '')), 1000), ''), auth.uid())
  returning id into v_id;
  update public.platform_fee_records set status = 'invoiced', platform_invoice_id = v_id
  where tenant_id = p_tenant and status = 'calculated' and platform_invoice_id is null;
  perform private.notify_permission(p_tenant, 'platform_billing:view', 'system',
    'FibrePulse invoice issued',
    format('Invoice for KSh %s is due on %s.', to_char(v_sum + v_tax, 'FM999,999,990.00'), to_char(v_today + p_due_days, 'DD Mon YYYY')),
    '/settings/billing', 'platform-invoice:' || v_id::text, null);
  return v_id;
end;
$$;

create or replace function public.admin_record_platform_payment(p_invoice uuid, p_reference text, p_paid_on date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.platform_invoice_status;
  v_issued timestamptz;
begin
  perform private.require_platform_admin();
  select status, issued_at into v_status, v_issued from public.platform_invoices where id = p_invoice for update;
  if not found or v_status not in ('issued', 'overdue') then
    raise exception 'Only an unpaid, issued invoice can be marked as paid.' using errcode = 'check_violation';
  end if;
  if p_reference is null or char_length(trim(p_reference)) < 3 then
    raise exception 'Enter the M-Pesa or bank reference of the payment.' using errcode = 'check_violation';
  end if;
  if p_paid_on is null or p_paid_on > (now() at time zone 'Africa/Nairobi')::date or p_paid_on < (v_issued at time zone 'Africa/Nairobi')::date - 1 then
    raise exception 'The payment date must be between the invoice date and today.' using errcode = 'check_violation';
  end if;
  update public.platform_invoices
  set status = 'paid', payment_reference = left(trim(p_reference), 120),
      paid_at = (p_paid_on::timestamp + interval '12 hours') at time zone 'Africa/Nairobi'
  where id = p_invoice;
end;
$$;

create or replace function public.admin_void_platform_invoice(p_invoice uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.platform_invoice_status;
begin
  perform private.require_platform_admin();
  select status into v_status from public.platform_invoices where id = p_invoice for update;
  if not found or v_status not in ('draft', 'issued', 'overdue') then
    raise exception 'Only an unpaid invoice can be voided.' using errcode = 'check_violation';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  perform set_config('fibrepulse.audit_reason', left(trim(p_reason), 500), true);
  update public.platform_invoices set status = 'void', void_reason = left(trim(p_reason), 500) where id = p_invoice;
  update public.platform_fee_records set status = 'calculated', platform_invoice_id = null where platform_invoice_id = p_invoice;
end;
$$;

-- -----------------------------------------------------------------------------
-- Platform analytics (super administrators; aggregates only)
-- -----------------------------------------------------------------------------
create or replace function public.admin_platform_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_month date := date_trunc('month', now() at time zone 'Africa/Nairobi')::date;
  v_mtd_e numeric := 0;
  v_mtd_f numeric := 0;
  t record;
  a public.commercial_agreements;
  b record;
begin
  perform private.require_platform_admin();
  for t in select id from public.tenants where status in ('active', 'suspended') loop
    a := private.agreement_for_month(t.id, v_month);
    if a.id is not null then
      select * into b from private.fee_base(t.id, v_month, v_today, a.fee_basis, a.excluded_categories);
      v_mtd_e := v_mtd_e + b.amount;
      v_mtd_f := v_mtd_f + round(b.amount * a.fee_rate, 2);
    end if;
  end loop;
  return (
    select jsonb_build_object(
      'tenants', (select count(*) from public.tenants),
      'active', (select count(*) from public.tenants where status = 'active'),
      'pending', (select count(*) from public.tenants where status = 'pending'),
      'suspended', (select count(*) from public.tenants where status = 'suspended'),
      'deactivated', (select count(*) from public.tenants where status = 'deactivated'),
      'signed_agreements', (select count(distinct tenant_id) from public.commercial_agreements where status = 'active'),
      'eligible_total', (select coalesce(sum(eligible_amount), 0) from public.platform_fee_records where status <> 'void'),
      'fees_total', (select coalesce(sum(fee_amount), 0) from public.platform_fee_records where status <> 'void'),
      'fees_uninvoiced', (select coalesce(sum(fee_amount), 0) from public.platform_fee_records where status = 'calculated'),
      'invoiced_total', (select coalesce(sum(total), 0) from public.platform_invoices where status in ('issued', 'overdue', 'paid')),
      'paid_total', (select coalesce(sum(total), 0) from public.platform_invoices where status = 'paid'),
      'unpaid_total', (select coalesce(sum(total), 0) from public.platform_invoices where status in ('issued', 'overdue')),
      'unpaid_count', (select count(*) from public.platform_invoices where status in ('issued', 'overdue')),
      'overdue_total', (select coalesce(sum(total), 0) from public.platform_invoices where status in ('issued', 'overdue') and due_date < v_today),
      'overdue_count', (select count(*) from public.platform_invoices where status in ('issued', 'overdue') and due_date < v_today),
      'customers', (select count(*) from public.customers c join public.tenants tn on tn.id = c.tenant_id
                    where c.status <> 'terminated' and c.data_source <> 'simulated' and tn.status in ('active', 'suspended')),
      'mtd_eligible', v_mtd_e,
      'mtd_fee', v_mtd_f,
      'month', v_month
    )
  );
end;
$$;

create or replace function public.admin_platform_monthly(p_months integer default 12)
returns table (month date, eligible numeric, fees numeric, invoiced numeric, paid numeric, new_isps integer, activated_isps integer, new_customers integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first date := (date_trunc('month', now() at time zone 'Africa/Nairobi') - make_interval(months => greatest(least(coalesce(p_months, 12), 36), 1) - 1))::date;
begin
  perform private.require_platform_admin();
  return query
  with m as (
    select gs::date as mo, (gs + interval '1 month')::date as nx
    from generate_series(v_first::timestamp, date_trunc('month', now() at time zone 'Africa/Nairobi'), interval '1 month') gs
  )
  select m.mo,
    coalesce((select sum(f.eligible_amount) from public.platform_fee_records f where f.status <> 'void' and f.period_start = m.mo), 0)::numeric,
    coalesce((select sum(f.fee_amount) from public.platform_fee_records f where f.status <> 'void' and f.period_start = m.mo), 0)::numeric,
    coalesce((select sum(i.total) from public.platform_invoices i where i.status in ('issued', 'overdue', 'paid')
              and (i.issued_at at time zone 'Africa/Nairobi')::date >= m.mo and (i.issued_at at time zone 'Africa/Nairobi')::date < m.nx), 0)::numeric,
    coalesce((select sum(i.total) from public.platform_invoices i where i.status = 'paid'
              and (i.paid_at at time zone 'Africa/Nairobi')::date >= m.mo and (i.paid_at at time zone 'Africa/Nairobi')::date < m.nx), 0)::numeric,
    (select count(*) from public.tenants t where (t.created_at at time zone 'Africa/Nairobi')::date >= m.mo
       and (t.created_at at time zone 'Africa/Nairobi')::date < m.nx)::integer,
    (select count(distinct l.entity_id) from public.audit_logs l where l.entity_type = 'tenants' and l.action = 'update'
       and l.after_data ->> 'status' = 'active' and coalesce(l.before_data ->> 'status', '') <> 'active'
       and (l.created_at at time zone 'Africa/Nairobi')::date >= m.mo and (l.created_at at time zone 'Africa/Nairobi')::date < m.nx)::integer,
    (select count(*) from public.customers c where c.data_source <> 'simulated'
       and c.registered_on >= m.mo and c.registered_on < m.nx)::integer
  from m order by m.mo;
end;
$$;

create or replace function public.admin_isp_revenue()
returns table (tenant_id uuid, name text, status public.tenant_status, agreement_state text, fee_rate numeric, fee_basis public.fee_basis,
               customers integer, active_subscriptions integer, mtd_eligible numeric, mtd_fee numeric,
               fees_total numeric, fees_uninvoiced numeric, unpaid numeric, overdue numeric, last_calculated date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_month date := date_trunc('month', now() at time zone 'Africa/Nairobi')::date;
  t record;
  a public.commercial_agreements;
  v_amt numeric;
begin
  perform private.require_platform_admin();
  for t in select x.id, x.name, x.status from public.tenants x order by x.name loop
    a := private.agreement_for_month(t.id, v_month);
    v_amt := null;
    if a.id is not null then
      select fb.amount into v_amt from private.fee_base(t.id, v_month, v_today, a.fee_basis, a.excluded_categories) fb;
    end if;
    return query select t.id, t.name, t.status,
      case when a.id is not null then 'signed'
           when exists (select 1 from public.commercial_agreements d where d.tenant_id = t.id and d.status = 'draft') then 'draft'
           else 'none' end,
      coalesce(a.fee_rate, (select d.fee_rate from public.commercial_agreements d where d.tenant_id = t.id and d.status = 'draft' limit 1)),
      a.fee_basis,
      (select count(*) from public.customers c where c.tenant_id = t.id and c.status <> 'terminated' and c.data_source <> 'simulated')::integer,
      (select count(*) from public.subscriptions s join public.customers c on c.id = s.customer_id
        where s.tenant_id = t.id and s.status = 'active' and c.data_source <> 'simulated')::integer,
      v_amt,
      case when a.id is not null then round(v_amt * a.fee_rate, 2) end,
      (select coalesce(sum(f.fee_amount), 0) from public.platform_fee_records f where f.tenant_id = t.id and f.status <> 'void')::numeric,
      (select coalesce(sum(f.fee_amount), 0) from public.platform_fee_records f where f.tenant_id = t.id and f.status = 'calculated')::numeric,
      (select coalesce(sum(i.total), 0) from public.platform_invoices i where i.tenant_id = t.id and i.status in ('issued', 'overdue'))::numeric,
      (select coalesce(sum(i.total), 0) from public.platform_invoices i where i.tenant_id = t.id and i.status in ('issued', 'overdue') and i.due_date < v_today)::numeric,
      (select max(f.period_start) from public.platform_fee_records f where f.tenant_id = t.id and f.status <> 'void');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Support access
-- -----------------------------------------------------------------------------
create or replace function public.request_support_access(p_tenant uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.is_platform_staff() then
    raise exception 'Only FibrePulse staff can request support access.' using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 10 then
    raise exception 'Explain what you need to look at (at least 10 characters).' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant and status in ('active', 'suspended', 'pending')) then
    raise exception 'ISP not found or deactivated.' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.support_access_grants g where g.tenant_id = p_tenant and g.granted_to = auth.uid()
             and g.revoked_at is null and (g.approved_at is null or g.expires_at > now())) then
    raise exception 'You already have an open request or active access for this ISP.' using errcode = 'check_violation';
  end if;
  insert into public.support_access_grants (tenant_id, granted_to, requested_reason)
  values (p_tenant, auth.uid(), left(trim(p_reason), 500))
  returning id into v_id;
  perform private.notify_permission(p_tenant, 'staff:manage', 'system', 'FibrePulse support asks for access',
    left(trim(p_reason), 300), '/settings/support-access', 'support-access:' || v_id::text, null);
  return v_id;
end;
$$;

-- ISP owner (staff:manage) approves for 1-72 hours, declines, or revokes.
create or replace function public.decide_support_access(p_grant uuid, p_decision text, p_hours integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.support_access_grants;
begin
  select * into g from public.support_access_grants where id = p_grant for update;
  if not found or not private.has_permission(g.tenant_id, 'staff:manage') then
    raise exception 'Only the ISP owner can decide on support access.' using errcode = 'insufficient_privilege';
  end if;
  if p_decision = 'approve' then
    if g.approved_at is not null or g.revoked_at is not null then
      raise exception 'This request has already been decided.' using errcode = 'check_violation';
    end if;
    if p_hours is null or p_hours < 1 or p_hours > 72 then
      raise exception 'Allow access for 1 to 72 hours.' using errcode = 'check_violation';
    end if;
    update public.support_access_grants
    set approved_by = auth.uid(), approved_at = now(), expires_at = now() + make_interval(hours => p_hours)
    where id = p_grant;
  elsif p_decision in ('decline', 'revoke') then
    if g.revoked_at is not null or (g.expires_at is not null and g.expires_at <= now()) then
      raise exception 'This access has already ended.' using errcode = 'check_violation';
    end if;
    update public.support_access_grants set revoked_at = now() where id = p_grant;
  else
    raise exception 'Unknown decision.' using errcode = 'check_violation';
  end if;
end;
$$;

-- Requests visible to FibrePulse staff: super admins see all, support admins their own.
create or replace function public.admin_support_grants()
returns table (id uuid, tenant_id uuid, tenant_name text, requested_by text, reason text, state text,
               created_at timestamptz, approved_at timestamptz, expires_at timestamptz, revoked_at timestamptz, mine boolean)
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
  select g.id, g.tenant_id, t.name, coalesce(nullif(p.full_name, ''), p.email::text), g.requested_reason,
    case when g.revoked_at is not null and g.approved_at is null then 'declined'
         when g.revoked_at is not null then 'revoked'
         when g.approved_at is null then 'waiting'
         when g.expires_at <= now() then 'expired'
         else 'active' end,
    g.created_at, g.approved_at, g.expires_at, g.revoked_at, g.granted_to = auth.uid()
  from public.support_access_grants g
  join public.tenants t on t.id = g.tenant_id
  left join public.profiles p on p.id = g.granted_to
  where private.is_platform_admin() or g.granted_to = auth.uid()
  order by g.created_at desc
  limit 200;
end;
$$;

-- Platform super admins can read the audit trail of support access too.
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    (tenant_id is not null and private.has_permission(tenant_id, 'audit:view')
       and entity_type not in ('commercial_agreements', 'platform_fee_records', 'platform_invoices'))
    or (private.is_platform_admin()
       and entity_type in ('tenants', 'commercial_agreements', 'platform_fee_records', 'platform_invoices', 'support_access_grants'))
  );

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.admin_save_agreement(uuid, uuid, numeric, public.fee_basis, public.revenue_category[], date, text)',
    'public.admin_discard_agreement(uuid)',
    'public.admin_sign_agreement(uuid, text)',
    'public.admin_end_agreement(uuid, date, text)',
    'public.admin_calculate_fees(uuid, date)',
    'public.admin_calculate_all_fees(date)',
    'public.admin_issue_platform_invoice(uuid, integer, numeric, text)',
    'public.admin_record_platform_payment(uuid, text, date)',
    'public.admin_void_platform_invoice(uuid, text)',
    'public.admin_platform_summary()',
    'public.admin_platform_monthly(integer)',
    'public.admin_isp_revenue()',
    'public.request_support_access(uuid, text)',
    'public.decide_support_access(uuid, text, integer)',
    'public.admin_support_grants()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
revoke all on function private.fee_base(uuid, date, date, public.fee_basis, public.revenue_category[]) from public, anon, authenticated;
revoke all on function private.agreement_for_month(uuid, date) from public, anon, authenticated;
revoke all on function private.tenant_tz(uuid) from public, anon, authenticated;

-- Registration creates a draft dated the day the ISP registered. Fees run per
-- calendar month, so a draft that does not start on the 1st moves to the 1st
-- of the next month (signing still checks the rule).
create or replace function private.draft_month_start()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'draft' and extract(day from new.effective_from) <> 1 then
    new.effective_from := (date_trunc('month', new.effective_from) + interval '1 month')::date;
  end if;
  return new;
end;
$$;
create trigger commercial_agreements_month_start before insert on public.commercial_agreements
  for each row execute function private.draft_month_start();
update public.commercial_agreements
set effective_from = (date_trunc('month', effective_from) + interval '1 month')::date
where status = 'draft' and extract(day from effective_from) <> 1;
