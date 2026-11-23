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

## Engineer checklist

- [ ] Daraja app (sandbox then production), shortcode, passkey, go-live approval with the pilot ISP.
- [ ] OAuth token caching; STK Push request; callback endpoint on a public HTTPS URL with a secret path or signature check, and Safaricom IP allow-listing.
- [ ] Idempotency on `CheckoutRequestID` and `MpesaReceiptNumber`; duplicate callbacks are no-ops.
- [ ] Mark payments verified only after Transaction Status query confirms them.
- [ ] Reversal API and result callbacks; C2B paybill validation/confirmation if the ISP uses a paybill.
- [ ] Never log full callback payloads containing phone numbers in plain application logs.
- [ ] Environment variables listed in `.env.example` (`MPESA_*`).
