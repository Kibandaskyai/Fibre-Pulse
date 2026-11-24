import { describe, expect, it } from "vitest";
import { LogSmsProvider, smsText, toMsisdn } from "@/lib/sms";
import { SafaricomSmsProvider, safaricomConfig } from "@/lib/sms/safaricom";

describe("SMS helpers", () => {
  it("turns Kenyan numbers into the 2547/2541 form and rejects others", () => {
    expect(toMsisdn("+254712345678")).toBe("254712345678");
    expect(toMsisdn("0712 345 678")).toBe("254712345678");
    expect(toMsisdn("0110345678")).toBe("254110345678");
    expect(toMsisdn("712345678")).toBe("254712345678");
    expect(toMsisdn("+255712345678")).toBeNull();
    expect(toMsisdn("0202345678")).toBeNull();
    expect(toMsisdn(null)).toBeNull();
  });

  it("fits one 160-character GSM SMS", () => {
    expect(smsText("New ticket", "TCK-0004 — “No internet”")).toBe('FibrePulse: New ticket: TCK-0004 - "No internet"');
    const long = smsText("Router offline", "x".repeat(400));
    expect(long.length).toBe(160);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("SMS providers", () => {
  it("the log provider never reports a message as sent", async () => {
    const lines: string[] = [];
    const r = await new LogSmsProvider((l) => lines.push(l)).send({ to: "254712345678", text: "hi" });
    expect(r.ok).toBe(false);
    expect(lines[0]).not.toContain("712345678");
  });

  it("Safaricom needs all its settings, over https", () => {
    expect(() => safaricomConfig({})).toThrow(/Missing: SAFARICOM_SMS_TOKEN_URL/);
    expect(() =>
      safaricomConfig({
        SAFARICOM_SMS_TOKEN_URL: "http://example.test/token", SAFARICOM_SMS_SEND_URL: "https://example.test/send",
        SAFARICOM_SMS_CONSUMER_KEY: "k", SAFARICOM_SMS_CONSUMER_SECRET: "s", SAFARICOM_SMS_SENDER_ID: "FIBREPULSE",
      }),
    ).toThrow(/https/);
  });

  it("until the engineer finishes the request, nothing is marked sent and the token is reused", async () => {
    let tokenCalls = 0;
    const fakeFetch = (async () => {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new SafaricomSmsProvider(
      { tokenUrl: "https://example.test/token", sendUrl: "https://example.test/send", consumerKey: "k", consumerSecret: "s", senderId: "FP", timeoutMs: 1000 },
      fakeFetch,
    );
    const a = await p.send({ to: "254712345678", text: "hi" });
    const b = await p.send({ to: "254712345678", text: "hi" });
    expect(a).toMatchObject({ ok: false, retry: true });
    expect(b.ok).toBe(false);
    expect(tokenCalls).toBe(1);
  });
});
