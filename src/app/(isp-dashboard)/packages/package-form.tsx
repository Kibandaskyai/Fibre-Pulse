"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { createPackageAction, updatePackageAction } from "@/modules/packages/actions";
import type { ServicePackage } from "@/modules/packages/service";

export function PackageForm({ pkg }: { pkg?: ServicePackage }) {
  const { state, pending, formProps } = useFormAction(pkg ? updatePackageAction : createPackageAction, { resetOnSuccess: false });
  const [period, setPeriod] = useState<string>(pkg?.billing_period ?? "monthly");
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      {pkg ? <input type="hidden" name="id" value={pkg.id} /> : null}
      <Field id="pkg-name" label="Package name" errors={e?.name}>
        <Input id="pkg-name" name="name" required defaultValue={pkg?.name} placeholder="Home 10 Mbps" />
      </Field>
      <Field id="pkg-type" label="Connection type" errors={e?.connectionType} hint="PPPoE for households with their own router. Static IP is billed the same way but is not disconnected automatically yet.">
        <NativeSelect id="pkg-type" name="connectionType" defaultValue={pkg?.connection_type ?? "pppoe"}>
          <option value="pppoe">PPPoE (household router)</option>
          <option value="static">Static IP</option>
        </NativeSelect>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pkg-down" label="Download speed (Mbps)" errors={e?.downloadMbps}>
          <Input id="pkg-down" name="downloadMbps" inputMode="decimal" required defaultValue={pkg?.download_mbps ?? ""} />
        </Field>
        <Field id="pkg-up" label="Upload speed (Mbps)" errors={e?.uploadMbps}>
          <Input id="pkg-up" name="uploadMbps" inputMode="decimal" required defaultValue={pkg?.upload_mbps ?? ""} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pkg-price" label="Price (Ksh)" errors={e?.price} hint="The price the customer pays by M-Pesa.">
          <Input id="pkg-price" name="price" inputMode="decimal" required defaultValue={pkg?.price ?? ""} />
        </Field>
        <Field id="pkg-period" label="Billing period" errors={e?.billingPeriod}>
          <NativeSelect id="pkg-period" name="billingPeriod" value={period} onChange={(ev) => setPeriod(ev.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly (calendar month)</option>
            <option value="custom">Custom number of days</option>
          </NativeSelect>
        </Field>
      </div>
      {period === "custom" ? (
        <Field id="pkg-days" label="Days of service" errors={e?.durationDays}>
          <Input id="pkg-days" name="durationDays" inputMode="numeric" defaultValue={pkg?.duration_days ?? ""} />
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pkg-limit" label="Data limit (GB)" errors={e?.dataLimitGb} hint="Leave blank for unlimited.">
          <Input id="pkg-limit" name="dataLimitGb" inputMode="decimal" defaultValue={pkg?.data_limit_gb ?? ""} />
        </Field>
        <Field id="pkg-profile" label="Router profile name" errors={e?.networkProfile} hint="The PPPoE/hotspot profile on your MikroTik, for later automation.">
          <Input id="pkg-profile" name="networkProfile" defaultValue={pkg?.network_profile ?? ""} />
        </Field>
      </div>
      <Field id="pkg-category" label="Revenue category" errors={e?.revenueCategory}>
        <NativeSelect id="pkg-category" name="revenueCategory" defaultValue={pkg?.revenue_category ?? "subscription"}>
          <option value="subscription">Subscription</option>
          <option value="installation">Installation</option>
          <option value="equipment">Equipment</option>
          <option value="other">Other</option>
        </NativeSelect>
      </Field>
      <Field id="pkg-fup" label="Fair usage policy" errors={e?.fairUsagePolicy}>
        <Textarea id="pkg-fup" name="fairUsagePolicy" rows={2} defaultValue={pkg?.fair_usage_policy ?? ""} />
      </Field>
      <Field id="pkg-desc" label="Description" errors={e?.description}>
        <Textarea id="pkg-desc" name="description" rows={2} defaultValue={pkg?.description ?? ""} />
      </Field>
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} pendingText="Saving…">{pkg ? "Save package" : "Create package"}</SubmitButton>
      </div>
    </form>
  );
}
