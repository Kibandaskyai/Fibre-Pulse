import { notFound } from "next/navigation";
import { ISP_NAV, TECHNICIAN_NAV } from "@/components/layout/nav-config";
import { requirePagePermission, requireTenant } from "@/lib/auth/guards";
import { ModulePlaceholder } from "./module-placeholder";

/** Server-rendered placeholder for an ISP module that ships in a later phase. */
export async function PlaceholderPage({ href }: { href: string }) {
  const item = ISP_NAV.find((i) => i.href === href);
  if (!item) notFound();
  if (item.permission) {
    const ctx = await requireTenant();
    // Technicians reach Field Operations through jobs:update_own.
    const techOk = href === TECHNICIAN_NAV.href && ctx.active.permissions.has("jobs:update_own");
    if (!techOk) await requirePagePermission(item.permission);
    return <ModulePlaceholder item={techOk && !ctx.active.permissions.has("jobs:view") ? TECHNICIAN_NAV : item} />;
  }
  await requireTenant();
  return <ModulePlaceholder item={item} />;
}
