"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { NavItem } from "./nav-config";
import { NavIcon } from "./nav-icon";

export function SidebarNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-active hover:text-foreground",
              active && "bg-sidebar-active font-medium text-foreground shadow-[inset_2px_0_0_var(--primary)]",
            )}
          >
            <NavIcon name={item.icon} className={cn("size-4 text-muted-foreground group-hover:text-foreground", active && "text-primary")} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
