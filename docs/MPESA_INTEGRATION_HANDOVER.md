# M-Pesa (Safaricom Daraja) integration handover

**Owner: the professional software engineer.** FibrePulse prepares everything around the integration; the live Daraja connection is implemented by the engineer.

> TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION.

## Already in place (Phase 1, database level)

- `payments` table with `method = 'mpesa'`, `provider_reference` (M-Pesa receipt number), `provider_payload` (raw callback JSON), `status`, `verification_status`, `reconciliation_status`, `data_source = 'provider'`.
- Duplicate protection: unique `(tenant_id, method, provider_reference)`.
- Immutability: amount, reference and date cannot change after insert; reversals are new rows with `reversal_of`.
- Only `status = 'successful' AND verification_status = 'verified'` counts as collected revenue.
- Staff cannot insert provider payments; only the server (service role) can.

## Added in Phase 2 (interfaces and stubs)

- `src/lib/integrations/payments/provider.ts`: `PaymentProvider` interface (`initiateStkPush`, `parseCallback`), `ManualPaymentProvider` (the one in use) and `DarajaPaymentProvider` (stub returning `not_configured`, with step-by-step TODO notes).
- `POST /api/payments/mpesa/stk-push` and `POST /api/payments/mpesa/callback` return 501. The callback path is public in `src/lib/supabase/proxy.ts` because Safaricom calls it; the route must authenticate requests itself.
- Manual flow that the live flow must match: record payment (unverified) → `verify_payment` → reconciliation record → `private.auto_allocate_customer` (oldest invoice first) → `private.recompute_invoice`. A provider-confirmed payment should end in the same state, written with the service role in the callback route only.
- Unmatched deposits (`customer_id` null) are linked later with `assign_payment_customer`, so a C2B paybill can reuse this.

## Added in Phase 3 (reconciliation)

- Statement upload at `/payments/reconcile`: parser `src/modules/reconciliation/statement.ts` (M-Pesa Org portal CSV: Receipt No., Completion Time, Details, Transaction Status, Paid In) and database function `reconcile_statement`. Matching is by method + reference + exact amount; only successful, unverified, non-simulated payments are verified.
- This stays useful after go-live as the monthly check against the paybill statement. When Daraja is live, provider-confirmed payments can be verified with `statement_source = 'provider_query'` after a Transaction Status query (see the TODO in the migration).
- Statement lines with no payment are stored as `unmatched` reconciliation records. A C2B confirmation handler could create those payments automatically.

## Added in Phase 8 (hotspot codes)

The pilot ISP sells most of its internet as hotspot time, paid to its paybill. Three paths, all ready at the database level:

1. **WiFi page (STK push).** `/wifi/<isp>` calls `hotspot_portal_buy` (anon, rate-limited 3 per phone per 10 minutes and 300 per ISP), which creates an `awaiting_payment` code. `src/modules/hotspot/portal-actions.ts` then calls `PaymentProvider.initiateStkPush` with `hotspotVoucherId`. When Daraja accepts the request, store its `CheckoutRequestID` with `set_hotspot_checkout(voucher, checkout_request_id)` (service role). In the callback, call `confirm_hotspot_payment(voucher, success, receipt, amount, phone, transaction_at, raw)` (service role). It is idempotent, rejects underpayment (code becomes `payment_failed`, money kept as an unmatched payment), and marks the payment `provider` + verified. The buyer's page polls `hotspot_portal_status` and shows the code.
2. **Paybill directly (C2B).** In the C2B confirmation handler call `record_paybill_hotspot_payment(tenant, receipt, amount, phone, account_reference, transaction_at, raw)`. It picks the active plan whose price equals the amount, issues a code and queues an SMS. If no plan matches it returns `unmatched` and the payment waits for the owner. Idempotent on the receipt.
3. **Owner sells by hand** after seeing the M-Pesa message: `sell_hotspot_voucher`, saved as an unverified manual payment, checked later against the statement like any other.

Unpaid prompts become `payment_failed` after 10 minutes. The demo ISP (`settings.portal_demo = true`) gets a "Simulate M-Pesa payment" button instead; simulated payments never count as revenue and the function refuses for any other ISP.

> TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION (STK push for `hotspotVoucherId`, the STK callback and the C2B validation/confirmation URLs for the paybill).

## Engineer checklist

- [ ] Daraja app (sandbox then production), shortcode, passkey, go-live approval with the pilot ISP.
- [ ] OAuth token caching; STK Push request; callback endpoint on a public HTTPS URL with a secret path or signature check, and Safaricom IP allow-listing.
- [ ] Idempotency on `CheckoutRequestID` and `MpesaReceiptNumber`; duplicate callbacks are no-ops.
- [ ] Mark payments verified only after Transaction Status query confirms them.
- [ ] Reversal API and result callbacks; C2B paybill validation/confirmation (the pilot ISP uses a paybill, see Phase 8 above).
- [ ] Hotspot STK push and callback wired to `set_hotspot_checkout` and `confirm_hotspot_payment`.
- [ ] Never log full callback payloads containing phone numbers in plain application logs.
- [ ] Environment variables listed in `.env.example` (`MPESA_*`).
