/**
 * SMS delivery worker: sends the SMS copies of notifications queued in
 * notification_outbox, through Safaricom in production.
 *
 *   npm run worker:sms            run continuously (every 30 seconds)
 *   npm run worker:sms -- --once  one pass, then exit
 *
 * Environment (worker machine only, never the browser or the Next.js app):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   database access for the outbox
 *   SMS_PROVIDER=log|safaricom                log prints and never sends
 *   SAFARICOM_SMS_*                           see src/lib/sms/safaricom.ts
 *
 * A message is marked "sent" only when the provider accepts it. Failures are
 * retried up to 5 times within 2 days; staff without a valid phone number
 * are skipped with a reason.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LogSmsProvider, smsText, toMsisdn, type SmsProvider } from "../src/lib/sms/index";
import { SafaricomSmsProvider, safaricomConfig } from "../src/lib/sms/safaricom";

type Row = { id: string; phone: string | null; title: string; body: string | null; attempts: number };

function provider(): SmsProvider {
  const name = process.env.SMS_PROVIDER ?? "log";
  if (name === "safaricom") return new SafaricomSmsProvider(safaricomConfig());
  if (name === "log") return new LogSmsProvider();
  throw new Error(`Unknown SMS_PROVIDER "${name}". Use log or safaricom.`);
}

async function pass(db: SupabaseClient, sms: SmsProvider) {
  const { data, error } = await db.rpc("outbox_claim_sms", { p_limit: 50 });
  if (error) throw new Error(`Could not read the outbox: ${error.message}`);
  let sent = 0;
  for (const row of (data ?? []) as Row[]) {
    const to = toMsisdn(row.phone);
    if (!to) {
      await db.rpc("outbox_mark", { p_id: row.id, p_status: "skipped", p_error: "No valid Kenyan mobile number on the staff profile." });
      continue;
    }
    const r = await sms.send({ to, text: smsText(row.title, row.body) });
    if (r.ok) {
      sent += 1;
      await db.rpc("outbox_mark", { p_id: row.id, p_status: "sent", p_error: null });
    } else {
      const status = !r.retry ? (sms.delivers ? "failed" : "skipped") : row.attempts >= 5 ? "failed" : "pending";
      await db.rpc("outbox_mark", { p_id: row.id, p_status: status, p_error: r.error });
    }
  }
  return { claimed: ((data ?? []) as Row[]).length, sent };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the SMS worker.");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const sms = provider();
  console.log(`SMS worker using provider "${sms.name}"${sms.delivers ? "" : " (prints only, sends nothing)"}.`);
  do {
    try {
      const r = await pass(db, sms);
      if (r.claimed) console.log(`SMS pass: ${r.claimed} claimed, ${r.sent} sent.`);
    } catch (e) {
      console.error((e as Error).message);
    }
    if (process.argv.includes("--once")) break;
    await new Promise((r) => setTimeout(r, 30_000));
  } while (true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
