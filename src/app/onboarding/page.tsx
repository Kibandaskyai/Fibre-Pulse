import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MailCheck } from "lucide-react";
import { BrandLogo } from "@/components/layout/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/shared/form-bits";
import { requireUser } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { acceptInvitationAction } from "@/modules/tenants/actions";
import { listMyInvitations } from "@/modules/tenants/service";
import { signOutAction } from "@/modules/auth/actions";
import { RegisterIspForm } from "./register-isp-form";

export const metadata: Metadata = { title: "Get started" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireUser();
  if (ctx.active) redirect("/overview");
  const { error } = await searchParams;
  const db = await createClient();
  const invitations = await listMyInvitations(db);

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <BrandLogo className="w-48" />
        <form action={signOutAction}>
          <button className="text-sm text-muted-foreground hover:text-foreground" type="submit">Sign out</button>
        </form>
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome{ctx.fullName ? `, ${ctx.fullName.split(" ")[0]}` : ""}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Join the ISP that invited you, or register your own ISP.</p>
      </div>

      {error ? (
        <Alert variant="danger"><AlertDescription className="text-foreground">{error}</AlertDescription></Alert>
      ) : null}

      {invitations.ok && invitations.data.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><MailCheck className="size-4 text-accent" aria-hidden /> Invitations for you</CardTitle>
            <CardDescription>Accepting gives you access with the role shown.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {invitations.data.map((inv) => (
              <form key={inv.id} action={acceptInvitationAction} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="font-medium">{inv.tenantName}</p>
                  <Badge variant="secondary" className="mt-1">{ROLE_LABELS[inv.role]}</Badge>
                </div>
                <input type="hidden" name="invitationId" value={inv.id} />
                <SubmitButton size="sm" pendingText="Joining…">Accept and join</SubmitButton>
              </form>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Register your ISP</CardTitle>
          <CardDescription>
            You become the owner. The workspace starts as pending until FibrePulse activates it; you can set it up in the meantime.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RegisterIspForm defaultOwnerName={ctx.fullName} />
        </CardContent>
      </Card>
    </div>
  );
}
