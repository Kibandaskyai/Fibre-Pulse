"use client";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Brand } from "./brand";
import type { NavItem } from "./nav-config";
import { SidebarNav } from "./sidebar-nav";

export function MobileNav({ items, subtitle }: { items: NavItem[]; subtitle?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="border-b px-4 py-4">
          <Brand subtitle={subtitle} />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <SidebarNav items={items} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
