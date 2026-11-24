/**
 * SMS delivery for FibrePulse notifications. The pilot uses Safaricom.
 *
 * Used by the delivery worker (scripts/deliver-sms.ts), never by the browser
 * and never by the Next.js app itself. Providers:
 *   SMS_PROVIDER=log        development: prints the message, marks it "skipped"
 *   SMS_PROVIDER=safaricom  production: see ./safaricom.ts
 * No provider ever reports a message as sent unless the provider accepted it.
 */
export type SmsMessage = { to: string; text: string };
export type SmsResult = { ok: true; providerId: string | null } | { ok: false; retry: boolean; error: string };

export interface SmsProvider {
  readonly name: string;
  /** True when the provider really sends (the log provider does not). */
  readonly delivers: boolean;
  send(message: SmsMessage): Promise<SmsResult>;
}

/** Kenyan mobile numbers in the international form Safaricom expects: 2547XXXXXXXX or 2541XXXXXXXX. */
export function toMsisdn(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/[\s()-]/g, "");
  const m = /^(?:\+?254|0)?([17]\d{8})$/.exec(digits);
  return m ? `254${m[1]}` : null;
}

/**
 * One SMS (160 GSM characters): title, then as much of the body as fits.
 * Non-GSM characters (curly quotes, dashes, emoji) are simplified so the
 * message is not split into expensive Unicode parts.
 */
export function smsText(title: string, body: string | null | undefined, max = 160): string {
  const plain = (s: string) =>
    s
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/…/g, "...")
      .replace(/[^\x20-\x7E\n]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const full = [plain(title), plain(body ?? "")].filter(Boolean).join(": ");
  const prefixed = `FibrePulse: ${full}`;
  return prefixed.length <= max ? prefixed : `${prefixed.slice(0, max - 3).trimEnd()}...`;
}

export class LogSmsProvider implements SmsProvider {
  readonly name = "log";
  readonly delivers = false;
  constructor(private out: (line: string) => void = console.log) {}
  async send(m: SmsMessage): Promise<SmsResult> {
    this.out(`[sms:log] to ${m.to.slice(0, 6)}****** : ${m.text}`);
    return { ok: false, retry: false, error: "SMS_PROVIDER=log: printed, not sent." };
  }
}
