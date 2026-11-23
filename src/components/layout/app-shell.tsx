import Link from "next/link";
import { Bell } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Brand } from "./brand";
import type { NavItem } from "./nav-config";
import { MobileNav } from "./mobile-nav";
import { SidebarNav } from "./sidebar-nav";
import { UserMenu, type UserMenuProps } from "./user-menu";

/**
 * Responsive application frame: fixed sidebar on desktop, slide-in menu on
 * tablet and phone, top bar with notifications and the account menu.
 */
export function AppShell({
  nav, subtitle, banner, unreadCount, user, children, areaLabel,
}: {
  nav: NavItem[];
  subtitle?: string;
  banner?: ReactNode;
  unreadCount: number;
  user: UserMenuProps;
  areaLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-sidebar lg:flex">
        <div className="border-b px-4 py-4">
          <Brand subtitle={subtitle} />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <SidebarNav items={nav} />
        </div>
        <div className="border-t px-4 py-3 text-[11px] text-muted-foreground">{areaLabel}</div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur sm:px-5">
          <MobileNav items={nav} subtitle={subtitle} />
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" asChild aria-label={`Notifications, ${unreadCount} unread`}>
              <Link href="/notifications" className="relative">
                <Bell />
                {unreadCount > 0 ? (
                  <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </Link>
            </Button>
            <UserMenu {...user} />
          </div>
        </header>
        {banner}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
