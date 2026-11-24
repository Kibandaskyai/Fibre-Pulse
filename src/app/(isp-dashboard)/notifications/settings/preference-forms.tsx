"use client";
import { FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { saveIspPreferencesAction, saveMyPreferencesAction } from "@/modules/notifications/actions";

type Row = { type: string; label: string; mine: { in_app: boolean; email: boolean; sms: boolean }; ispOff: boolean };

const Box = ({ name, checked, label, disabled }: { name: string; checked: boolean; label: string; disabled?: boolean }) => (
  <td className="px-3 py-2 text-center">
    <input type="checkbox" name={name} defaultChecked={checked} disabled={disabled} aria-label={label} className="size-4" />
  </td>
);

export function MyPreferencesForm({ rows }: { rows: Row[] }) {
  const { state, pending, formProps } = useFormAction(saveMyPreferencesAction, { resetOnSuccess: false });
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Notification</th>
              <th className="px-3 py-2 text-center font-medium">In app</th>
              <th className="px-3 py-2 text-center font-medium">Email</th>
              <th className="px-3 py-2 text-center font-medium">SMS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.type} className="border-t">
                <td className="py-2">
                  {r.label}
                  {r.ispOff ? <span className="block text-xs text-warning">Turned off for everyone by your ISP owner</span> : null}
                </td>
                <Box name={`${r.type}.in_app`} checked={r.mine.in_app} label={`${r.label} in app`} />
                <Box name={`${r.type}.email`} checked={r.mine.email} label={`${r.label} by email`} />
                <Box name={`${r.type}.sms`} checked={r.mine.sms} label={`${r.label} by SMS`} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">Save my choices</SubmitButton></div>
    </form>
  );
}

export function IspPreferencesForm({ rows }: { rows: Row[] }) {
  const { state, pending, formProps } = useFormAction(saveIspPreferencesAction, { resetOnSuccess: false });
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <ul className="grid gap-2 text-sm">
        {rows.map((r) => (
          <li key={r.type}>
            <label className="flex items-center gap-2">
              <input type="checkbox" name={`${r.type}.in_app`} defaultChecked={!r.ispOff} className="size-4" /> {r.label}
            </label>
          </li>
        ))}
      </ul>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} variant="outline" pendingText="Saving…">Save for everyone</SubmitButton></div>
    </form>
  );
}
