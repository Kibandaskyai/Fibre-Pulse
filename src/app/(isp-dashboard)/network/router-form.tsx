"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { createRouterAction, setRouterCredentialsAction, updateRouterAction } from "@/modules/network/actions";

export type RouterFormValues = {
  id: string; name: string; management_address: string | null; api_port: number | null; api_scheme: "https" | "http"; verify_tls: boolean;
  connector_agent_id: string | null; location_name: string | null; latitude: number | null; longitude: number | null; monitoring_enabled: boolean;
};

function Check({ id, name, label, hint, defaultChecked }: { id: string; name: string; label: string; hint: string; defaultChecked: boolean }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input id={id} name={name} type="checkbox" defaultChecked={defaultChecked} className="mt-0.5 size-4 accent-[var(--primary)]" />
      <span>{label}<span className="block text-xs text-muted-foreground">{hint}</span></span>
    </label>
  );
}

export function RouterForm({ router, connectors }: { router?: RouterFormValues; connectors: { id: string; name: string }[] }) {
  const { state, pending, formProps } = useFormAction(router ? updateRouterAction : createRouterAction, { resetOnSuccess: false });
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      {router ? <input type="hidden" name="id" value={router.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="r-name" label="Name" errors={e?.name} hint="How staff know it, e.g. “Ruiru core”.">
          <Input id="r-name" name="name" required autoComplete="off" defaultValue={router?.name} />
        </Field>
        <Field id="r-connector" label="Connector" errors={e?.connectorAgentId} hint="The connector that can reach this router.">
          <NativeSelect id="r-connector" name="connectorAgentId" defaultValue={router?.connector_agent_id ?? ""}>
            <option value="">Not assigned yet</option>
            {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
        <Field id="r-addr" label="Management IP address" errors={e?.managementAddress} hint="As the connector sees it, usually a private address.">
          <Input id="r-addr" name="managementAddress" inputMode="decimal" autoComplete="off" placeholder="192.168.88.1" defaultValue={router?.management_address ?? ""} />
        </Field>
        <Field id="r-scheme" label="REST API" errors={e?.apiScheme}>
          <NativeSelect id="r-scheme" name="apiScheme" defaultValue={router?.api_scheme ?? "https"}>
            <option value="https">HTTPS (www-ssl)</option>
            <option value="http">HTTP (www)</option>
          </NativeSelect>
        </Field>
        <Field id="r-port" label="Port" errors={e?.apiPort} hint="Blank uses 443 or 80.">
          <Input id="r-port" name="apiPort" inputMode="numeric" defaultValue={router?.api_port ?? ""} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="r-loc" label="Site (optional)" errors={e?.locationName}>
          <Input id="r-loc" name="locationName" defaultValue={router?.location_name ?? ""} placeholder="Ruiru POP" />
        </Field>
        <Field id="r-lat" label="Latitude (optional)" errors={e?.latitude}>
          <Input id="r-lat" name="latitude" inputMode="decimal" defaultValue={router?.latitude ?? ""} placeholder="-1.1460" />
        </Field>
        <Field id="r-lng" label="Longitude (optional)" errors={e?.longitude}>
          <Input id="r-lng" name="longitude" inputMode="decimal" defaultValue={router?.longitude ?? ""} placeholder="36.9610" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Check id="r-mon" name="monitoringEnabled" label="Monitor this router" hint="The connector reads it every minute." defaultChecked={router?.monitoring_enabled ?? true} />
        <Check id="r-tls" name="verifyTls" label="Check the router's HTTPS certificate" hint="Turn on once the router has a trusted certificate. Off accepts RouterOS's self-signed one." defaultChecked={router?.verify_tls ?? false} />
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">{router ? "Save router" : "Add router"}</SubmitButton></div>
    </form>
  );
}

/** Write-only: saved passwords are never sent back to the browser. */
export function CredentialsForm({ routerId, currentUser }: { routerId: string; currentUser: string | null }) {
  const { state, pending, formProps } = useFormAction(setRouterCredentialsAction);
  return (
    <form {...formProps} className="grid gap-3" noValidate autoComplete="off">
      <input type="hidden" name="routerId" value={routerId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="rc-user" label="API username" hint={currentUser ? `Saved user: ${currentUser}` : "A RouterOS user just for FibrePulse."}>
          <Input id="rc-user" name="username" autoComplete="off" required />
        </Field>
        <Field id="rc-pass" label="API password" hint="Encrypted before it is stored. It cannot be shown again.">
          <Input id="rc-pass" name="password" type="password" autoComplete="new-password" required />
        </Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Encrypting…" variant="outline">{currentUser ? "Replace credentials" : "Save credentials"}</SubmitButton></div>
    </form>
  );
}
