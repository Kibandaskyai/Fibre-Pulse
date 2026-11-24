"use client";
import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { createConnectorAction } from "@/modules/network/actions";

/** Registers a connector. The token comes back once, is shown here, and is never stored in readable form. */
export function ConnectorForm({ siteUrl }: { siteUrl: string }) {
  const { state, pending, formProps } = useFormAction(createConnectorAction);
  const [copied, setCopied] = useState(false);
  const created = state?.ok ? state.data : undefined;
  const token = created?.token;
  const env = token ? `FIBREPULSE_URL=${siteUrl}\nFIBREPULSE_TOKEN=${token}\nALLOW_ROUTER_WRITES=false` : "";
  return (
    <div className="grid gap-4">
      <form {...formProps} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" noValidate>
        <Field id="cn-name" label="Connector name" hint="Where it runs, for example “Ruiru POP server”.">
          <Input id="cn-name" name="name" required autoComplete="off" maxLength={80} />
        </Field>
        <div><SubmitButton pending={pending} pendingText="Registering…"><KeyRound aria-hidden /> Register connector</SubmitButton></div>
      </form>
      {state && !state.ok ? <FormMessage state={state} /> : null}
      {token ? (
        <Alert variant="success" aria-live="polite">
          <AlertTitle>Connector “{created?.name}” registered. Copy the token now.</AlertTitle>
          <AlertDescription className="grid gap-3 text-foreground">
            <p>This is the only time the token is shown. FibrePulse keeps only a fingerprint of it, so it cannot be recovered. If you lose it, revoke this connector and register a new one.</p>
            <div className="flex gap-2">
              <Input readOnly value={token} aria-label="Connector token" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} data-testid="connector-token" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(token).then(() => setCopied(true), () => setCopied(false))}
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p>Put these lines in the connector&apos;s <code>.env</code> file on a computer inside your network that can reach the routers:</p>
            <pre className="overflow-x-auto rounded-md border bg-background/60 p-3 text-xs">{env}</pre>
            <p className="text-xs text-muted-foreground">Then start it with <code>npm start</code>, Docker or the systemd unit (see the connector&apos;s README). It appears as active here within a minute.</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
