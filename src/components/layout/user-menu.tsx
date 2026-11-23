"use client";
import { Building2, Check, LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutAction } from "@/modules/auth/actions";
import { switchTenantAction } from "@/modules/tenants/actions";

export type UserMenuProps = {
  fullName: string;
  email: string;
  roleLabel: string;
  memberships: { tenantId: string; tenantName: string }[];
  activeTenantId: string | null;
  showAdminLink: boolean;
  showIspLink: boolean;
};

function initials(name: string, email: string) {
  const source = name.trim() || email;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

export function UserMenu(p: UserMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-2" aria-label="Account menu">
          <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-semibold">{initials(p.fullName, p.email)}</span>
          <span className="hidden text-left leading-tight md:block">
            <span className="block max-w-40 truncate text-sm">{p.fullName || p.email}</span>
            <span className="block text-[11px] text-muted-foreground">{p.roleLabel}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block truncate text-sm text-foreground">{p.fullName || "Your account"}</span>
          <span className="block truncate">{p.email}</span>
        </DropdownMenuLabel>
        {p.memberships.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Switch ISP</DropdownMenuLabel>
            {p.memberships.map((m) => (
              <form key={m.tenantId} action={switchTenantAction}>
                <input type="hidden" name="tenantId" value={m.tenantId} />
                <DropdownMenuItem asChild>
                  <button type="submit" className="w-full">
                    <Building2 aria-hidden />
                    <span className="flex-1 truncate text-left">{m.tenantName}</span>
                    {m.tenantId === p.activeTenantId ? <Check className="text-primary" aria-label="Current" /> : null}
                  </button>
                </DropdownMenuItem>
              </form>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        {p.showAdminLink ? (
          <DropdownMenuItem asChild>
            <a href="/admin">
              <UserRound aria-hidden /> FibrePulse admin
            </a>
          </DropdownMenuItem>
        ) : null}
        {p.showIspLink ? (
          <DropdownMenuItem asChild>
            <a href="/overview">
              <Building2 aria-hidden /> ISP dashboard
            </a>
          </DropdownMenuItem>
        ) : null}
        <form action={signOutAction}>
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full">
              <LogOut aria-hidden /> Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
