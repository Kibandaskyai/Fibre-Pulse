-- =============================================================================
-- FibrePulse migration 0006: subscriptions, invoices and payment functions
-- (Phase 2: ISP business operations)
--
-- Multi-row money operations run inside these SECURITY DEFINER functions so
-- each one is a single database transaction. Every function checks the
-- caller's permission in the row's tenant before changing anything, and
-- records a reason in the audit log where the spec asks for one.
--
-- Revenue rule (spec Module 4): only payments that are status = 'successful'
-- AND verification_status = 'verified' count towards an invoice being paid.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Period maths, in the ISP's own time zone
-- -----------------------------------------------------------------------------

-- End of a service period that starts at p_from. Monthly periods are calendar
-- months (31 Jan + 1 month = 28/29 Feb). Days are local calendar days, so a
-- daily package bought at 20:00 EAT ends 20:00 EAT the next day.
create or replace function private.period_end(
  p_from    timestamptz,
  p_period  public.billing_period,
  p_days    integer,
  p_tz      text default 'Africa/Nairobi'
)
returns timestamptz
language sql
immutable
as $$
  select case p_period
    when 'monthly' then ((p_from at time zone p_tz) + interval '1 month') at time zone p_tz
    else ((p_from at time zone p_tz) + make_interval(days => p_days)) at time zone p_tz
  end
$$;

create or replace function private.tenant_today(p_tenant uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce((select timezone from public.tenants where id = p_tenant), 'Africa/Nairobi'))::date
$$;

create or replace function private.require_permission(p_tenant uuid, p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_tenant is null or not private.has_permission(p_tenant, p_permission) then
    raise exception 'You do not have permission to do that.' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

create or replace function private.set_audit_reason(p_reason text)
returns void
language sql
as $$
  select set_config('fibrepulse.audit_reason', coalesce(left(trim(p_reason), 500), ''), true)
$$;

-- -----------------------------------------------------------------------------
-- Invoice balances
-- -----------------------------------------------------------------------------

-- Recalculate amount_paid and status from allocations of verified payments.
create or replace function private.recompute_invoice(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paid numeric(14, 2);
begin
  select coalesce(sum(a.amount), 0) into v_paid
  from public.payment_allocations a
  join public.payments p on p.id = a.payment_id
  where a.invoice_id = p_invoice
    and p.status = 'successful'
    and p.verification_status = 'verified';

  update public.invoices i
  set amount_paid = least(v_paid, i.total),
      status = case
        when i.status in ('void', 'draft') then i.status
        when v_paid >= i.total then 'paid'::public.invoice_status
        when v_paid > 0 then 'partially_paid'::public.invoice_status
        else 'issued'::public.invoice_status
      end
  where i.id = p_invoice;
end;
$$;

-- Unallocated amount of a payment.
create or replace function private.payment_unallocated(p_payment uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select p.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.payment_id = p.id), 0)
  from public.payments p where p.id = p_payment
$$;

-- Apply a customer's verified, unallocated payments to their open invoices,
-- oldest invoice first.
create or replace function private.auto_allocate_customer(p_tenant uuid, p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay   record;
  inv   record;
  v_left numeric(14, 2);
  v_due  numeric(14, 2);
  v_take numeric(14, 2);
begin
  for pay in
    select p.id from public.payments p
    where p.tenant_id = p_tenant and p.customer_id = p_customer
      and p.status = 'successful' and p.verification_status = 'verified'
    order by p.transaction_at, p.id
    for update
  loop
    v_left := private.payment_unallocated(pay.id);
    continue when v_left <= 0;
    for inv in
      select i.id, i.total from public.invoices i
      where i.tenant_id = p_tenant and i.customer_id = p_customer
        and i.status in ('issued', 'partially_paid')
      order by i.issue_date, i.created_at, i.id
      for update
    loop
      exit when v_left <= 0;
      select inv.total - coalesce(sum(a.amount), 0) into v_due
      from public.payment_allocations a where a.invoice_id = inv.id;
      continue when v_due <= 0;
      v_take := least(v_left, v_due);
      insert into public.payment_allocations (tenant_id, payment_id, invoice_id, amount, created_by)
      values (p_tenant, pay.id, inv.id, v_take, auth.uid())
      on conflict (payment_id, invoice_id) do update set amount = public.payment_allocations.amount + excluded.amount;
      v_left := v_left - v_take;
      perform private.recompute_invoice(inv.id);
    end loop;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Invoices
-- -----------------------------------------------------------------------------

-- Create an issued invoice with lines in one step. p_lines is a JSON array of
-- {"description": text, "category": revenue_category, "quantity": n, "unit_price": n}.
create or replace function public.create_invoice(
  p_customer uuid,
  p_lines jsonb,
  p_due_date date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid;
  v_invoice uuid;
  v_line    jsonb;
  v_amount  numeric(14, 2);
  v_total   numeric(14, 2) := 0;
  v_today   date;
begin
  select tenant_id into v_tenant from public.customers where id = p_customer;
  perform private.require_permission(v_tenant, 'invoices:edit');
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An invoice needs at least one line.' using errcode = 'check_violation';
  end if;
  v_today := private.tenant_today(v_tenant);

  insert into public.invoices (tenant_id, customer_id, issue_date, due_date, status, notes, created_by)
  values (v_tenant, p_customer, v_today, coalesce(p_due_date, v_today), 'issued', p_notes, auth.uid())
  returning id into v_invoice;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_amount := round((v_line ->> 'quantity')::numeric * (v_line ->> 'unit_price')::numeric, 2);
    insert into public.invoice_lines (tenant_id, invoice_id, description, category, quantity, unit_price, amount)
    values (v_tenant, v_invoice, v_line ->> 'description', (v_line ->> 'category')::public.revenue_category,
            (v_line ->> 'quantity')::numeric, (v_line ->> 'unit_price')::numeric, v_amount);
    v_total := v_total + v_amount;
  end loop;

  update public.invoices set subtotal = v_total, total = v_total,
         status = case when v_total = 0 then 'paid'::public.invoice_status else 'issued'::public.invoice_status end
  where id = v_invoice;

  perform private.auto_allocate_customer(v_tenant, p_customer);
  return v_invoice;
end;
$$;

-- Void an unpaid invoice (for mistakes). Paid or part-paid invoices cannot be
-- voided; reverse the payment first.
create or replace function public.void_invoice(p_invoice uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices;
begin
  select * into v_inv from public.invoices where id = p_invoice for update;
  perform private.require_permission(v_inv.tenant_id, 'invoices:edit');
  if coalesce(char_length(trim(p_reason)), 0) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.payment_allocations where invoice_id = p_invoice) then
    raise exception 'This invoice has payments allocated. Reverse or reallocate them first.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(p_reason);
  update public.invoices set status = 'void' where id = p_invoice;
end;
$$;

-- -----------------------------------------------------------------------------
-- Subscriptions
-- -----------------------------------------------------------------------------

-- Buy a package for a customer: new subscription, renewal, upgrade or
-- downgrade, decided from the customer's current live subscription.
--   * Renewal of the same package extends from the current expiry, so no
--     paid days are lost.
--   * Upgrade/downgrade starts the new package now for a full period.
--     ASSUMPTION (confirm with pilot ISP): no proration credit.
-- Always issues an invoice for the package price in the same transaction,
-- then applies any verified unallocated payments the customer has.
-- Never sends a command to a router.
create or replace function public.purchase_subscription(p_customer uuid, p_package uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust    public.customers;
  v_pkg     public.service_packages;
  v_live    public.subscriptions;
  v_tz      text;
  v_change  public.subscription_change;
  v_base    timestamptz;
  v_end     timestamptz;
  v_sub     uuid;
  v_invoice uuid;
  v_today   date;
begin
  select * into v_cust from public.customers where id = p_customer;
  perform private.require_permission(v_cust.tenant_id, 'subscriptions:edit');
  if v_cust.status = 'terminated' then
    raise exception 'This customer account is terminated.' using errcode = 'check_violation';
  end if;

  select * into v_pkg from public.service_packages where id = p_package and tenant_id = v_cust.tenant_id;
  if not found or v_pkg.status <> 'active' then
    raise exception 'Choose an active package.' using errcode = 'check_violation';
  end if;

  select timezone into v_tz from public.tenants where id = v_cust.tenant_id;

  select * into v_live from public.subscriptions
  where tenant_id = v_cust.tenant_id and customer_id = p_customer and status in ('active', 'suspended')
  for update;

  if found and v_live.status = 'suspended' then
    raise exception 'The current subscription is suspended. Restore it before renewing or changing package.'
      using errcode = 'check_violation';
  end if;

  if not found then
    v_change := 'new';
    v_base := now();
  elsif v_live.package_id = p_package then
    v_change := 'renewal';
    v_base := greatest(now(), v_live.expires_at);
  else
    v_change := case when v_pkg.price >= v_live.price then 'upgrade' else 'downgrade' end;
    v_base := now();
  end if;

  v_end := private.period_end(v_base, v_pkg.billing_period, v_pkg.duration_days, v_tz);

  if v_live.id is not null then
    update public.subscriptions set status = 'expired', ended_at = now() where id = v_live.id;
  end if;

  insert into public.subscriptions (tenant_id, customer_id, package_id, status, change_type, starts_at, expires_at,
                                    price, billing_period, previous_subscription_id, created_by)
  values (v_cust.tenant_id, p_customer, p_package, 'active', v_change, now(), v_end,
          v_pkg.price, v_pkg.billing_period, v_live.id, auth.uid())
  returning id into v_sub;

  v_today := private.tenant_today(v_cust.tenant_id);
  insert into public.invoices (tenant_id, customer_id, subscription_id, issue_date, due_date, subtotal, tax_amount, total, status, created_by)
  values (v_cust.tenant_id, p_customer, v_sub, v_today, v_today, v_pkg.price, 0, v_pkg.price,
          case when v_pkg.price = 0 then 'paid'::public.invoice_status else 'issued'::public.invoice_status end, auth.uid())
  returning id into v_invoice;

  insert into public.invoice_lines (tenant_id, invoice_id, description, category, quantity, unit_price, amount)
  values (v_cust.tenant_id, v_invoice,
          left(format('%s (%s) %s to %s', v_pkg.name, v_change,
                      to_char(now() at time zone v_tz, 'DD Mon YYYY'), to_char(v_end at time zone v_tz, 'DD Mon YYYY')), 200),
          v_pkg.revenue_category, 1, v_pkg.price, v_pkg.price);

  if v_cust.status = 'pending_installation' and v_change = 'new' then
    null; -- Installation completion (Phase 5) moves the customer to active.
  end if;

  perform private.auto_allocate_customer(v_cust.tenant_id, p_customer);
  return v_sub;
end;
$$;

-- Suspend a live subscription in FibrePulse. This does NOT disconnect the
-- customer on the network: router commands need a separate authorised
-- integration (spec Module 3).
create or replace function public.suspend_subscription(p_subscription uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
begin
  select * into v_sub from public.subscriptions where id = p_subscription for update;
  perform private.require_permission(v_sub.tenant_id, 'subscriptions:suspend');
  if v_sub.status <> 'active' then
    raise exception 'Only an active subscription can be suspended.' using errcode = 'check_violation';
  end if;
  if coalesce(char_length(trim(p_reason)), 0) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(p_reason);
  update public.subscriptions set status = 'suspended', suspended_at = now(), suspension_reason = trim(p_reason)
  where id = p_subscription;
end;
$$;

create or replace function public.restore_subscription(p_subscription uuid, p_reason text)
returns public.subscription_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_new public.subscription_status;
begin
  select * into v_sub from public.subscriptions where id = p_subscription for update;
  perform private.require_permission(v_sub.tenant_id, 'subscriptions:suspend');
  if v_sub.status <> 'suspended' then
    raise exception 'Only a suspended subscription can be restored.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(coalesce(nullif(trim(p_reason), ''), 'Restored'));
  v_new := case when v_sub.expires_at > now() then 'active' else 'expired' end;
  update public.subscriptions
  set status = v_new, suspended_at = null, suspension_reason = null,
      ended_at = case when v_new = 'expired' then now() else null end
  where id = p_subscription;
  return v_new;
end;
$$;

create or replace function public.cancel_subscription(p_subscription uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
begin
  select * into v_sub from public.subscriptions where id = p_subscription for update;
  perform private.require_permission(v_sub.tenant_id, 'subscriptions:edit');
  if v_sub.status not in ('active', 'suspended', 'pending') then
    raise exception 'This subscription has already ended.' using errcode = 'check_violation';
  end if;
  if coalesce(char_length(trim(p_reason)), 0) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(p_reason);
  update public.subscriptions set status = 'cancelled', ended_at = now() where id = p_subscription;
end;
$$;

-- Mark subscriptions whose period has ended as expired. Idempotent. Called
-- when subscription screens load and, from Phase 3, by the background worker.
create or replace function public.expire_due_subscriptions(p_tenant uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not (private.is_member(p_tenant) or auth.role() = 'service_role') then
    raise exception 'You do not have permission to do that.' using errcode = 'insufficient_privilege';
  end if;
  perform private.set_audit_reason('Subscription period ended');
  update public.subscriptions set status = 'expired', ended_at = expires_at
  where tenant_id = p_tenant and status = 'active' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Payments
-- -----------------------------------------------------------------------------

-- Confirm a recorded payment against a bank or M-Pesa statement. Only
-- verified payments count as collected revenue. Applies the payment to the
-- customer's open invoices.
create or replace function public.verify_payment(
  p_payment uuid,
  p_statement_source text,
  p_statement_reference text default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments;
begin
  select * into v_pay from public.payments where id = p_payment for update;
  perform private.require_permission(v_pay.tenant_id, 'payments:reconcile');
  if v_pay.data_source = 'simulated' then
    raise exception 'Simulated payments can never be verified.' using errcode = 'check_violation';
  end if;
  if v_pay.status <> 'successful' or v_pay.verification_status <> 'unverified' then
    raise exception 'Only a successful, unverified payment can be verified.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(coalesce(p_notes, 'Verified against ' || p_statement_source));

  update public.payments
  set verification_status = 'verified', verified_by = auth.uid(), verified_at = now(), reconciliation_status = 'matched'
  where id = p_payment;

  insert into public.payment_reconciliation_records
    (tenant_id, payment_id, statement_source, statement_reference, statement_amount, statement_date, result, notes, matched_by)
  values (v_pay.tenant_id, p_payment, p_statement_source, p_statement_reference, v_pay.amount,
          (v_pay.transaction_at at time zone 'Africa/Nairobi')::date, 'matched', p_notes, auth.uid());

  if v_pay.customer_id is not null then
    perform private.auto_allocate_customer(v_pay.tenant_id, v_pay.customer_id);
  end if;
end;
$$;

-- Record that a payment could not be confirmed (e.g. not on the statement).
create or replace function public.reject_payment(p_payment uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments;
begin
  select * into v_pay from public.payments where id = p_payment for update;
  perform private.require_permission(v_pay.tenant_id, 'payments:reconcile');
  if v_pay.verification_status <> 'unverified' then
    raise exception 'Only an unverified payment can be rejected.' using errcode = 'check_violation';
  end if;
  if coalesce(char_length(trim(p_reason)), 0) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(p_reason);
  update public.payments set verification_status = 'rejected', reconciliation_status = 'disputed' where id = p_payment;
  insert into public.payment_reconciliation_records (tenant_id, payment_id, statement_source, result, notes, matched_by)
  values (v_pay.tenant_id, p_payment, 'manual_review', 'disputed', trim(p_reason), auth.uid());
end;
$$;

-- Reverse a payment (e.g. bank recall, M-Pesa reversal). The payment row is
-- kept with status 'reversed'; its allocations are removed and invoice
-- balances recalculated. Nothing is deleted from the audit trail.
create or replace function public.reverse_payment(p_payment uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments;
  v_inv uuid;
begin
  select * into v_pay from public.payments where id = p_payment for update;
  perform private.require_permission(v_pay.tenant_id, 'payments:reconcile');
  if v_pay.status <> 'successful' then
    raise exception 'Only a successful payment can be reversed.' using errcode = 'check_violation';
  end if;
  if coalesce(char_length(trim(p_reason)), 0) < 5 then
    raise exception 'Give a reason of at least 5 characters.' using errcode = 'check_violation';
  end if;
  perform private.set_audit_reason(p_reason);
  update public.payments set status = 'reversed' where id = p_payment;
  for v_inv in delete from public.payment_allocations where payment_id = p_payment returning invoice_id loop
    perform private.recompute_invoice(v_inv);
  end loop;
end;
$$;

-- Manually apply part of a verified payment to a specific invoice.
create or replace function public.allocate_payment(p_payment uuid, p_invoice uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments;
  v_inv public.invoices;
begin
  select * into v_pay from public.payments where id = p_payment for update;
  select * into v_inv from public.invoices where id = p_invoice for update;
  perform private.require_permission(v_pay.tenant_id, 'payments:reconcile');
  if v_inv.tenant_id is distinct from v_pay.tenant_id then
    raise exception 'Invoice not found.' using errcode = 'check_violation';
  end if;
  if v_pay.status <> 'successful' or v_pay.verification_status <> 'verified' then
    raise exception 'Only verified payments can be allocated.' using errcode = 'check_violation';
  end if;
  if v_inv.status not in ('issued', 'partially_paid') then
    raise exception 'This invoice is not open.' using errcode = 'check_violation';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > private.payment_unallocated(p_payment) then
    raise exception 'Amount is more than the unallocated balance of the payment.' using errcode = 'check_violation';
  end if;
  insert into public.payment_allocations (tenant_id, payment_id, invoice_id, amount, created_by)
  values (v_pay.tenant_id, p_payment, p_invoice, round(p_amount, 2), auth.uid())
  on conflict (payment_id, invoice_id) do update set amount = public.payment_allocations.amount + excluded.amount;
  perform private.recompute_invoice(p_invoice);
end;
$$;

-- Link an unmatched payment (e.g. a paybill deposit) to a customer.
create or replace function public.assign_payment_customer(p_payment uuid, p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay public.payments;
begin
  select * into v_pay from public.payments where id = p_payment for update;
  perform private.require_permission(v_pay.tenant_id, 'payments:reconcile');
  if v_pay.customer_id is not null then
    raise exception 'This payment already belongs to a customer.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.customers where id = p_customer and tenant_id = v_pay.tenant_id) then
    raise exception 'Customer not found.' using errcode = 'check_violation';
  end if;
  -- customer_id is not one of the immutable payment fields.
  update public.payments set customer_id = p_customer where id = p_payment;
  if v_pay.status = 'successful' and v_pay.verification_status = 'verified' then
    perform private.auto_allocate_customer(v_pay.tenant_id, p_customer);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Account summary per customer (respects RLS through security_invoker)
-- -----------------------------------------------------------------------------
create or replace view public.customer_account_summary
with (security_invoker = true)
as
select
  c.tenant_id,
  c.id as customer_id,
  coalesce((select sum(i.total - i.amount_paid) from public.invoices i
            where i.customer_id = c.id and i.status in ('issued', 'partially_paid')), 0)::numeric(14, 2) as outstanding,
  coalesce((select sum(p.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.payment_id = p.id), 0))
            from public.payments p
            where p.customer_id = c.id and p.status = 'successful' and p.verification_status = 'verified'), 0)::numeric(14, 2) as credit,
  (select max(p.transaction_at) from public.payments p
   where p.customer_id = c.id and p.status = 'successful' and p.verification_status = 'verified') as last_payment_at
from public.customers c;

grant select on public.customer_account_summary to authenticated;
revoke all on public.customer_account_summary from anon;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on function private.period_end(timestamptz, public.billing_period, integer, text) from public, anon;
revoke all on function private.recompute_invoice(uuid) from public, anon, authenticated;
revoke all on function private.auto_allocate_customer(uuid, uuid) from public, anon, authenticated;
revoke all on function private.payment_unallocated(uuid) from public, anon;
grant execute on function private.period_end(timestamptz, public.billing_period, integer, text) to authenticated;
grant execute on function private.payment_unallocated(uuid) to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.create_invoice(uuid, jsonb, date, text)',
    'public.void_invoice(uuid, text)',
    'public.purchase_subscription(uuid, uuid)',
    'public.suspend_subscription(uuid, text)',
    'public.restore_subscription(uuid, text)',
    'public.cancel_subscription(uuid, text)',
    'public.expire_due_subscriptions(uuid)',
    'public.verify_payment(uuid, text, text, text)',
    'public.reject_payment(uuid, text)',
    'public.reverse_payment(uuid, text)',
    'public.allocate_payment(uuid, uuid, numeric)',
    'public.assign_payment_customer(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Money and subscription state change only through the functions above.
-- Direct table writes from the browser are removed so that every verification,
-- allocation and status change goes through one checked, audited path.
-- (Customers, packages and manual payment recording keep direct inserts.)
-- -----------------------------------------------------------------------------
drop policy payments_update on public.payments;
drop policy payment_allocations_insert on public.payment_allocations;
drop policy payment_reconciliation_insert on public.payment_reconciliation_records;
drop policy invoices_insert on public.invoices;
drop policy invoices_update on public.invoices;
drop policy invoice_lines_write on public.invoice_lines;
drop policy subscriptions_insert on public.subscriptions;
drop policy subscriptions_update on public.subscriptions;
