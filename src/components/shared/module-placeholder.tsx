import { Construction } from "lucide-react";
import { PageHeader } from "./page-header";
import { EmptyState } from "./empty-state";
import type { NavItem } from "@/components/layout/nav-config";

/**
 * Shown for modules whose screens are scheduled for a later phase. The
 * database tables, permissions and RLS for them already exist.
 */
export function ModulePlaceholder({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <EmptyState
        icon={<Construction />}
        title={`This screen is built in Phase ${item.phase}`}
        description="Its database tables, permissions and tenant isolation are already in place and tested. No sample figures are shown here, so nothing on this page can be mistaken for real data."
      />
    </>
  );
}
