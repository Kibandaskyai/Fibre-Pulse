/**
 * Payment provider boundary.
 *
 * FibrePulse never fakes a successful payment. In this build only the manual
 * provider works: staff record a payment they can see on a statement, and a
 * person with payments:reconcile verifies it (public.verify_payment).
 *
 * The Daraja provider is a stub for the software engineer who takes over.
 * See docs/MPESA_INTEGRATION_HANDOVER.md.
 */

export type StkPushRequest = {
  tenantId: string;
  customerId: string;
  invoiceId: string | null;
  /** E.164 Kenyan number, e.g. +254712345678. Daraja wants 2547XXXXXXXX. */
  phone: string;
  /** Whole shillings. Daraja does not accept cents. */
  amount: number;
  accountReference: string;
  description: string;
};

export type StkPushResult =
  | { ok: true; merchantRequestId: string; checkoutRequestId: string; customerMessage: string }
  | { ok: false; code: "not_configured" | "provider_error" | "invalid_request"; message: string };

/** What a provider callback becomes after its signature/source is checked. */
export type ProviderPaymentEvent = {
  tenantId: string;
  method: "mpesa";
  providerReference: string; // M-Pesa receipt, e.g. SKL4H7XY2Q
  amount: number;
  transactionAt: string; // ISO
  payerPhone: string | null;
  status: "successful" | "failed" | "cancelled";
  checkoutRequestId: string | null;
  raw: unknown;
};

export interface PaymentProvider {
  readonly name: "manual" | "daraja";
  /** True when the provider can start collections from FibrePulse. */
  readonly canInitiate: boolean;
  initiateStkPush(req: StkPushRequest): Promise<StkPushResult>;
  /**
   * Parse and authenticate a provider callback. Must reject anything that
   * cannot be proven to come from the provider.
   */
  parseCallback(request: Request): Promise<ProviderPaymentEvent | null>;
}

/** The only provider that works in this build. */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = "manual" as const;
  readonly canInitiate = false;
  async initiateStkPush(): Promise<StkPushResult> {
    return { ok: false, code: "not_configured", message: "Automatic M-Pesa collection is not set up yet. Record the payment manually." };
  }
  async parseCallback(): Promise<ProviderPaymentEvent | null> {
    return null;
  }
}

/**
 * TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
 *
 * 1. OAuth: GET {DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials with
 *    basic auth from DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET. Cache the token
 *    server-side until shortly before it expires.
 * 2. STK push: POST /mpesa/stkpush/v1/processrequest with BusinessShortCode,
 *    Password = base64(shortcode + passkey + timestamp), Timestamp (EAT, yyyyMMddHHmmss),
 *    TransactionType, Amount (whole shillings), PartyA/PhoneNumber (2547…), PartyB,
 *    CallBackURL ({APP_URL}/api/payments/mpesa/callback?t=<per-tenant secret>),
 *    AccountReference (invoice or customer number), TransactionDesc.
 *    Store CheckoutRequestID on a pending payment row (data_source 'provider').
 * 3. Callback: authenticate (per-tenant secret in the URL, Safaricom IP allow-list,
 *    and confirm with the STK query API before trusting it). Then, with the service
 *    role, update the pending row to successful with the MpesaReceiptNumber, set
 *    verification_status 'verified' (provider-confirmed), insert a reconciliation
 *    record and call private.auto_allocate_customer. Idempotent on the receipt
 *    number (payments_reference_unique already rejects duplicates).
 * 4. C2B paybill (optional): register validation/confirmation URLs per tenant;
 *    unmatched deposits arrive with customer_id null for assign_payment_customer.
 * 5. Per-tenant shortcode, passkey and consumer secrets are stored encrypted, never
 *    in the browser, never in logs.
 */
export class DarajaPaymentProvider implements PaymentProvider {
  readonly name = "daraja" as const;
  readonly canInitiate = false;
  async initiateStkPush(): Promise<StkPushResult> {
    // TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
    return { ok: false, code: "not_configured", message: "Daraja integration is not implemented in this build." };
  }
  async parseCallback(): Promise<ProviderPaymentEvent | null> {
    // TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
    return null;
  }
}

/** Provider used by the app. Switch to Daraja only once it is implemented and tested. */
export function getPaymentProvider(): PaymentProvider {
  return new ManualPaymentProvider();
}
