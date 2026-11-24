"use client";
import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, FlaskConical, Loader2, Smartphone, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatData, formatPlanDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { buyAction, simulatePaymentAction, statusAction, type BuyResult, type StatusResult } from "@/modules/hotspot/portal-actions";

export type PortalInfo = {
  name: string;
  paybill: string | null;
  support_phone: string | null;
  demo: boolean;
  network_ok: boolean;
  clock_start?: "payment" | "first_login";
  plans: { id: string; name: string; price: number; duration_minutes: number; download_mbps: number; usage_type: string; data_limit_mb?: number | null }[];
};

export function BuyWifi({ slug, info, mac, loginUrl, dst, error }: { slug: string; info: PortalInfo; mac: string | null; loginUrl: string | null; dst: string; error: string }) {
  const [plan, setPlan] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [buy, setBuy] = useState<BuyResult | null>(null);
  const [status, setStatus] = useState<StatusResult>(null);
  const [pending, start] = useTransition();
  const voucherId = buy?.ok ? buy.voucherId : null;
  const code = status?.code ?? null;

  // Wait for M-Pesa: ask every 3 seconds for up to 3 minutes.
  useEffect(() => {
    if (!voucherId || code) return;
    let n = 0;
    const t = setInterval(async () => {
      n += 1;
      const s = await statusAction(slug, voucherId);
      if (s) setStatus(s);
      if ((s && s.status !== "awaiting_payment") || n > 60) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [slug, voucherId, code]);

  const submit = () =>
    start(async () => {
      setStatus(null);
      setBuy(await buyAction(slug, { planId: plan, phone, mac }));
    });

  return (
    <div className="mx-auto grid max-w-md gap-5">
      <header className="text-center">
        <Wifi className="mx-auto size-8 text-primary" aria-hidden />
        <h1 className="mt-2 text-2xl font-semibold">{info.name} WiFi</h1>
        <p className="text-sm text-muted-foreground">Buy internet time for this device. Each phone or gadget needs its own code.</p>
        {info.demo ? (
          <p className="mx-auto mt-2 inline-flex items-center gap-1 rounded-full border border-simulated/40 bg-simulated/10 px-2 py-0.5 text-xs uppercase tracking-wide text-simulated">
            <FlaskConical className="size-3" aria-hidden /> Demo: payments are simulated
          </p>
        ) : null}
      </header>

      {!info.network_ok ? (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm">
          <WifiOff className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <p><strong>Internet is temporarily unavailable.</strong> Please do not pay now. Try again a little later.</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">{error}</p> : null}

      {code ? (
        <section className="grid gap-3 rounded-xl border border-success/40 bg-success/10 p-5 text-center" aria-live="polite">
          <CheckCircle2 className="mx-auto size-8 text-success" aria-hidden />
          <p className="text-sm">Paid. Your code for {status?.plan}:</p>
          <p className="tabular text-3xl font-semibold tracking-[0.35em]" data-testid="wifi-code">{code}</p>
          {status?.simulated ? <p className="text-xs text-simulated">SIMULATED demo code: it does not open a real network.</p> : null}
          <p className="text-xs text-muted-foreground">
            {info.clock_start === "first_login" ? "Time starts when you connect." : "Your time has started."} It works on this device only.
          </p>
          {loginUrl ? (
            <form method="post" action={loginUrl}>
              <input type="hidden" name="username" value={code} />
              <input type="hidden" name="password" value={code} />
              {dst ? <input type="hidden" name="dst" value={dst} /> : null}
              <Button type="submit" className="w-full">Connect now</Button>
            </form>
          ) : null}
        </section>
      ) : (
        <>
          <section aria-labelledby="plans-h" className="grid gap-2">
            <h2 id="plans-h" className="text-sm font-medium">1. Choose a plan</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {info.plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPlan(p.id)}
                  aria-pressed={plan === p.id}
                  className={cn(
                    "rounded-lg border px-3 py-3 text-left transition-colors",
                    plan === p.id ? "border-primary bg-primary/10" : "hover:border-primary/50",
                  )}
                >
                  <span className="block text-sm font-medium">{formatPlanDuration(p.duration_minutes)}</span>
                  <span className="tabular block text-lg font-semibold">Ksh {Number(p.price).toLocaleString("en-KE")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {Number(p.download_mbps)} Mbps · {p.usage_type === "limited" && p.data_limit_mb ? formatData(p.data_limit_mb) : "Unlimited data"}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="grid gap-2">
            <Label htmlFor="wifi-phone">2. Your M-Pesa number</Label>
            <Input id="wifi-phone" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
            {buy && !buy.ok ? <p role="alert" className="text-sm text-danger">{buy.message}</p> : null}
            <Button onClick={submit} disabled={pending || !plan || !phone || !info.network_ok}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Smartphone aria-hidden />}
              Pay with M-Pesa
            </Button>
          </section>
          {buy?.ok ? (
            <section className="grid gap-3 rounded-lg border p-4 text-sm" aria-live="polite">
              <p>{buy.message}</p>
              {status?.status === "payment_failed" ? <p className="text-danger">The payment did not go through. Try again.</p> : null}
              {buy.prompt === "simulate" ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    start(async () => {
                      await simulatePaymentAction(slug, buy.voucherId);
                      setStatus(await statusAction(slug, buy.voucherId));
                    })
                  }
                >
                  <FlaskConical aria-hidden /> Simulate M-Pesa payment (demo)
                </Button>
              ) : status?.status !== "payment_failed" ? (
                <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Waiting for M-Pesa…</p>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      {loginUrl && !code ? (
        <details className="rounded-lg border p-4 text-sm">
          <summary className="cursor-pointer font-medium">I already have a code</summary>
          <form method="post" action={loginUrl} className="mt-3 grid gap-2">
            <Label htmlFor="wifi-code">Code</Label>
            <Input id="wifi-code" name="username" autoCapitalize="characters" autoComplete="off" required
              onChange={(e) => { const pw = e.currentTarget.form?.elements.namedItem("password") as HTMLInputElement | null; if (pw) pw.value = e.currentTarget.value.toUpperCase(); }} />
            <input type="hidden" name="password" defaultValue="" />
            {dst ? <input type="hidden" name="dst" value={dst} /> : null}
            <Button type="submit" variant="outline">Connect</Button>
          </form>
        </details>
      ) : null}

      <footer className="text-center text-xs text-muted-foreground">
        {info.paybill ? <p>Paybill {info.paybill}</p> : null}
        {info.support_phone ? <p>Help: {info.support_phone.replace(/^\+254/, "0")}</p> : null}
      </footer>
    </div>
  );
}
