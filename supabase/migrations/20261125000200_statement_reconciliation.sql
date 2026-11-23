-- =============================================================================
-- FibrePulse Phase 3: statement reconciliation
--
-- An ISP downloads its M-Pesa paybill or bank statement and uploads it. The
-- app parses the file (src/modules/reconciliation/statement.ts) into lines and
-- passes them here. Matching happens in the database so the result cannot be
-- tampered with in the browser:
--
--   reconcile_statement(tenant, source, lines, apply = false)  -> preview
--   reconcile_statement(tenant, source, lines, apply = true)   -> verify + record
--
-- A line matches a payment when the reference (M-Pesa receipt number or bank
-- reference) and the method agree. It is only verified when the amount is
-- exactly the same, the payment is successful and unverified, and it is not
-- simulated. Statement lines that FibrePulse has no payment for are recorded
-- as 'unmatched' so someone can follow them up. Nothing else is changed.
--
-- TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
-- Once Daraja callbacks and the Transaction Status / Account Balance queries
-- are live, provider-confirmed payments can be verified automatically with
-- statement_source 'provider_query'. This upload stays as the monthly check.
-- =============================================================================

create or replace function public.reconcile_statement(
  p_tenant uuid,
  p_source text,
  p_lines jsonb,
  p_apply boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_method public.payment_method;
  v_line jsonb;
  v_idx int := 0;
  v_ref text;
  v_amount numeric(14, 2);
  v_date date;
  v_pay public.payments;
  v_customer text;
  v_outcome text;
  v_note text;
  v_seen text[] := '{}';
  v_out jsonb := '[]'::jsonb;
  v_min date;
  v_max date;
  v_verified int := 0;
  v_recorded int := 0;
  v_missing jsonb;
begin
  perform private.require_permission(p_tenant, 'payments:reconcile');
  if p_source not in ('mpesa_statement', 'bank_statement') then
    raise exception 'Unknown statement type.' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Statement lines must be a list.' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'A statement can have at most 5,000 lines. Split the file by month.' using errcode = 'check_violation';
  end if;
  v_method := case p_source when 'mpesa_statement' then 'mpesa'::public.payment_method else 'bank_transfer'::public.payment_method end;
  if p_apply then
    perform private.set_audit_reason('Statement reconciliation (' || p_source || ')');
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_idx := v_idx + 1;
    v_ref := upper(nullif(trim(v_line ->> 'reference'), ''));
    v_amount := round((v_line ->> 'amount')::numeric, 2);
    v_date := nullif(v_line ->> 'date', '')::date;
    v_pay := null;
    v_customer := null;
    v_note := null;
    -- The statement's period, used to find payments missing from it.
    if v_date is not null then
      v_min := least(coalesce(v_min, v_date), v_date);
      v_max := greatest(coalesce(v_max, v_date), v_date);
    end if;

    if v_ref is null or v_amount is null or v_amount <= 0 then
      v_outcome := 'invalid';
      v_note := 'Line has no reference or no amount received.';
    elsif v_ref = any (v_seen) then
      v_outcome := 'duplicate_line';
      v_note := 'This reference appears earlier in the file.';
    else
      v_seen := v_seen || v_ref;

      select p.* into v_pay
      from public.payments p
      where p.tenant_id = p_tenant and p.method = v_method and upper(p.provider_reference) = v_ref
      for update;

      if v_pay.id is null then
        v_outcome := 'not_in_system';
        v_note := 'No payment with this reference has been recorded.';
      else
        select c.full_name into v_customer from public.customers c where c.tenant_id = p_tenant and c.id = v_pay.customer_id;
        if v_pay.data_source = 'simulated' then
          v_outcome := 'simulated';
          v_note := 'This is a simulated test payment and can never be verified.';
        elsif v_pay.verification_status = 'verified' then
          v_outcome := 'already_verified';
        elsif v_pay.verification_status = 'rejected' then
          v_outcome := 'needs_review';
          v_note := 'The payment was rejected earlier but is on the statement.';
        elsif v_pay.status <> 'successful' then
          v_outcome := 'needs_review';
          v_note := 'The payment is ' || v_pay.status::text || ' in FibrePulse.';
        elsif v_pay.amount <> v_amount then
          v_outcome := 'amount_mismatch';
          v_note := 'Recorded as ' || v_pay.amount::text || ' but the statement shows ' || v_amount::text || '.';
        else
          v_outcome := 'match';
        end if;
      end if;

      if p_apply and v_outcome = 'match' then
        update public.payments
        set verification_status = 'verified', verified_by = auth.uid(), verified_at = now(), reconciliation_status = 'matched'
        where id = v_pay.id;
        -- Link a line recorded as unmatched on an earlier upload, if any.
        update public.payment_reconciliation_records
        set payment_id = v_pay.id, result = 'matched', matched_by = auth.uid(),
            notes = left(coalesce(notes || ' · ', '') || 'Payment recorded later and matched', 300)
        where tenant_id = p_tenant and payment_id is null and statement_source = p_source and statement_reference = v_ref;
        if not found then
          insert into public.payment_reconciliation_records
            (tenant_id, payment_id, statement_source, statement_reference, statement_amount, statement_date, result, notes, matched_by)
          values (p_tenant, v_pay.id, p_source, v_ref, v_amount, v_date, 'matched', 'Matched on statement upload', auth.uid());
        end if;
        if v_pay.customer_id is not null then
          perform private.auto_allocate_customer(p_tenant, v_pay.customer_id);
        end if;
        v_outcome := 'verified';
        v_verified := v_verified + 1;
      elsif p_apply and v_outcome = 'not_in_system' then
        if not exists (
          select 1 from public.payment_reconciliation_records r
          where r.tenant_id = p_tenant and r.payment_id is null and r.statement_source = p_source and r.statement_reference = v_ref
        ) then
          insert into public.payment_reconciliation_records
            (tenant_id, payment_id, statement_source, statement_reference, statement_amount, statement_date, result, notes, matched_by)
          values (p_tenant, null, p_source, v_ref, v_amount, v_date, 'unmatched',
                  left(nullif(trim(v_line ->> 'details'), ''), 300), auth.uid());
          v_recorded := v_recorded + 1;
        end if;
      end if;
    end if;

    v_out := v_out || jsonb_build_object(
      'line', coalesce((v_line ->> 'line')::int, v_idx),
      'reference', v_ref,
      'amount', v_amount,
      'date', v_date,
      'details', left(v_line ->> 'details', 120),
      'outcome', v_outcome,
      'note', v_note,
      'payment_id', v_pay.id,
      'payment_amount', v_pay.amount,
      'customer', v_customer
    );
  end loop;

  -- Unverified payments in the statement's date range that are not on it.
  select coalesce(jsonb_agg(jsonb_build_object(
           'payment_id', p.id, 'reference', p.provider_reference, 'amount', p.amount,
           'transaction_at', p.transaction_at, 'customer', c.full_name) order by p.transaction_at), '[]'::jsonb)
  into v_missing
  from public.payments p
  left join public.customers c on c.tenant_id = p.tenant_id and c.id = p.customer_id
  where p.tenant_id = p_tenant
    and p.method = v_method
    and p.data_source <> 'simulated'
    and p.status = 'successful'
    and p.verification_status = 'unverified'
    and v_min is not null
    and (p.transaction_at at time zone 'Africa/Nairobi')::date between v_min and v_max
    and not (upper(coalesce(p.provider_reference, '')) = any (v_seen));

  return jsonb_build_object(
    'lines', v_out,
    'missing', v_missing,
    'from', v_min,
    'to', v_max,
    'applied', p_apply,
    'verified', v_verified,
    'recorded_unmatched', v_recorded
  );
end;
$$;

revoke all on function public.reconcile_statement(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.reconcile_statement(uuid, text, jsonb, boolean) to authenticated;

-- Statement lines nobody has followed up, for the reconciliation page.
-- (Read through RLS: payment_reconciliation_records is visible to
-- payments:view in the tenant.)
