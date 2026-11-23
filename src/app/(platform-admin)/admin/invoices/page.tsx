import { notFound } from "next/navigation";
import { PLATFORM_NAV } from "@/components/layout/nav-config";
import { ModulePlaceholder } from "@/components/shared/module-placeholder";
import { requirePlatformStaff } from "@/lib/auth/guards";

export default async function InvoicesPage() {
  await requirePlatformStaff();
  const item = PLATFORM_NAV.find((i) => i.href === "/admin/invoices");
  if (!item) notFound();
  return <ModulePlaceholder item={item} />;
}
