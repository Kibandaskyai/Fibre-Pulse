import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { requirePagePermission } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { revokeInvitationAction, setMemberStatusAction } from "@/modules/tenants/actions";
import { listOpenInvitations, listStaff } from "@/modules/tenants/service";
import { InviteForm } from "./invite-form";
import { RoleSelect } from "./role-select";

export const metadata: Metadata = { title: "Staff and roles" };

const dateFmt = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone: "Africa/Nairobi" });

export default async function StaffPage() {
  const ctx = await requirePagePermission("staff:manage");
  const db = await createClient();
  const [staff, invitations] = await Promise.all([listStaff(db, ctx.active.tenantId), listOpenInvitations(db, ctx.active.tenantId)]);

  return (
    <>
      <PageHeader title="Staff and roles" description="Each role sees only what it needs. Changes are recorded in the audit log." />
      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Team</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              {!staff.ok ? (
                <p className="px-5 text-sm text-danger">{staff.message}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden md:table-cell">Joined</TableHead>
                      <TableHead className="text-right">Access</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {staff.data.map((m) => {
                      const self = m.profileId === ctx.userId;
                      return (
                        <TableRow key={m.id}>
                          <TableCell>
                            <p className="font-medium">{m.fullName || "—"} {self ? <Badge variant="secondary">You</Badge> : null}</p>
                            <p className="text-xs text-muted-foreground">{m.email}</p>
                          </TableCell>
                          <TableCell>{self ? ROLE_LABELS[m.role] : <RoleSelect memberId={m.id} role={m.role} />}</TableCell>
                          <TableCell><TenantStatusBadge status={m.status} /></TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">{dateFmt.format(new Date(m.joinedAt))}</TableCell>
                          <TableCell className="text-right">
                            {self ? null : (
                              <form action={setMemberStatusAction}>
                                <input type="hidden" name="memberId" value={m.id} />
                                <input type="hidden" name="status" value={m.status === "active" ? "disabled" : "active"} />
                                <Button size="sm" variant={m.status === "active" ? "outline" : "secondary"} type="submit">
                                  {m.status === "active" ? "Disable" : "Enable"}
                                </Button>
                              </form>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Open invitations</CardTitle>
              <CardDescription>The person signs up with this email and accepts from their welcome page. Invitations expire after 7 days.</CardDescription>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              {invitations.ok && invitations.data.length ? (
                <Table>
                  <TableBody>
                    {invitations.data.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell>{i.email}</TableCell>
                        <TableCell>{ROLE_LABELS[i.role]}</TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">Expires {dateFmt.format(new Date(i.expiresAt))}</TableCell>
                        <TableCell className="text-right">
                          <form action={revokeInvitationAction}>
                            <input type="hidden" name="invitationId" value={i.id} />
                            <Button size="sm" variant="ghost" type="submit">Revoke</Button>
                          </form>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="px-5 pb-3 text-sm text-muted-foreground">No open invitations.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Invite staff</CardTitle>
            <CardDescription>Email delivery arrives with notifications; for now share the sign-up link yourself.</CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
