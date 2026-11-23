import { NextResponse } from "next/server";

/**
 * Safaricom Daraja result callback.
 *
 * TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
 * Authenticate the request before reading it (per-tenant secret, IP allow-list,
 * confirm with the STK query API). This is one of only two places allowed to use
 * the Supabase service role. Never mark a payment verified from an unauthenticated
 * callback. Always answer Safaricom with {"ResultCode":0} once stored, so it does
 * not retry, and make processing idempotent on the M-Pesa receipt number.
 */
export async function POST() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}
