import { NextResponse } from "next/server";

/**
 * Start an M-Pesa STK push for a customer.
 *
 * TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
 * Check the session and payments:record permission, validate the body with Zod,
 * create a pending payment row, then call DarajaPaymentProvider.initiateStkPush.
 * See src/lib/integrations/payments/provider.ts and docs/MPESA_INTEGRATION_HANDOVER.md.
 */
export async function POST() {
  return NextResponse.json(
    { error: "not_implemented", message: "Automatic M-Pesa collection is not available yet. Record payments manually." },
    { status: 501 },
  );
}
