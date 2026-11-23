# M-Pesa (Safaricom Daraja) integration handover

**Owner: the professional software engineer.** FibrePulse prepares everything around the integration; the live Daraja connection is implemented by the engineer.

> TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION.

## Already in place (Phase 1, database level)

- `payments` table with `method = 'mpesa'`, `provider_reference` (M-Pesa receipt number), `provider_payload` (raw callback JSON), `status`, `verification_status`, `reconciliation_status`, `data_source = 'provider'`.
- Duplicate protection: unique `(tenant_id, method, provider_reference)`.
- Immutability: amount, reference and date cannot change after insert; reversals are new rows with `reversal_of`.
- Only `status = 'successful' AND verification_status = 'verified'` counts as collected revenue.
- Staff cannot insert provider payments; only the server (service role) can.

## Coming in Phase 2 (interfaces and stubs)

- `src/lib/integrations/payments/provider.ts`: `PaymentProvider` interface (`initiateStkPush`, `handleCallback`, `queryTransactionStatus`, `requestReversal`).
- `ManualPaymentProvider` (working) and `DarajaPaymentProvider` (stub that throws with the TODO marker).
- `POST /api/payments/mpesa/stk-push` and `POST /api/payments/mpesa/callback` placeholders returning 501.

## Engineer checklist

- [ ] Daraja app (sandbox then production), shortcode, passkey, go-live approval with the pilot ISP.
- [ ] OAuth token caching; STK Push request; callback endpoint on a public HTTPS URL with a secret path or signature check, and Safaricom IP allow-listing.
- [ ] Idempotency on `CheckoutRequestID` and `MpesaReceiptNumber`; duplicate callbacks are no-ops.
- [ ] Mark payments verified only after Transaction Status query confirms them.
- [ ] Reversal API and result callbacks; C2B paybill validation/confirmation if the ISP uses a paybill.
- [ ] Never log full callback payloads containing phone numbers in plain application logs.
- [ ] Environment variables listed in `.env.example` (`MPESA_*`).
