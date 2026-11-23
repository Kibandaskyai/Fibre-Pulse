import type { Permission } from "@/lib/auth/permissions";

/**
 * ISP navigation (spec Part 9). An item shows only when the user's role has
 * its permission. `phase` says when the module's full screen is built; until
 * then the route shows a clear "coming in Phase N" state, never fake data.
 */
export type NavItem = {
  href: string;
  label: string;
  icon:
    | "overview" | "customers" | "packages" | "subscriptions" | "payments" | "revenue" | "network"
    | "map" | "alerts" | "support" | "field" | "reports" | "settings" | "tenants" | "agreements"
    | "invoices" | "shield" | "audit";
  permission: Permission | null;
  phase: number;
  description: string;
};

export const ISP_NAV: NavItem[] = [
  { href: "/overview", label: "Overview", icon: "overview", permission: null, phase: 3, description: "Executive dashboard: customers, collections and network health at a glance." },
  { href: "/customers", label: "Customers", icon: "customers", permission: "customers:view", phase: 2, description: "Register, search and manage subscribers, with payment, connection and support history." },
  { href: "/packages", label: "Packages", icon: "packages", permission: "packages:view", phase: 2, description: "Internet packages with speeds, prices, billing periods and fair usage policies." },
  { href: "/subscriptions", label: "Subscriptions", icon: "subscriptions", permission: "subscriptions:view", phase: 2, description: "Activate, renew, upgrade, suspend and restore customer subscriptions." },
  { href: "/payments", label: "Payments", icon: "payments", permission: "payments:view", phase: 2, description: "M-Pesa and bank payments, invoices, allocation and duplicate detection." },
  { href: "/revenue", label: "Revenue", icon: "revenue", permission: "revenue:view", phase: 3, description: "Verified collections, outstanding balances and revenue by package, area and method." },
  { href: "/network", label: "Network Monitoring", icon: "network", permission: "network:view", phase: 4, description: "MikroTik routers, sessions, CPU, memory and bandwidth through the FibrePulse Connector." },
  { href: "/network-map", label: "Network Map", icon: "map", permission: "network:view", phase: 5, description: "Customers, routers, outages and coverage on a map, with location privacy by role." },
  { href: "/alerts", label: "Alerts", icon: "alerts", permission: "alerts:view", phase: 4, description: "Network alerts and incident history." },
  { href: "/support", label: "Support Desk", icon: "support", permission: "tickets:view", phase: 5, description: "Customer tickets, priorities, assignment and resolution." },
  { href: "/field-operations", label: "Field Operations", icon: "field", permission: "jobs:view", phase: 5, description: "Installations, maintenance visits and fault investigations for technicians." },
  { href: "/reports", label: "Reports", icon: "reports", permission: null, phase: 3, description: "Daily and monthly financial reports with CSV/PDF downloads. Network, support and BI reports follow in Phase 5." },
  { href: "/settings", label: "Settings", icon: "settings", permission: null, phase: 1, description: "Organisation details, staff and roles." },
];

/** Technicians see their own jobs even without jobs:view. */
export const TECHNICIAN_NAV: NavItem = {
  href: "/field-operations",
  label: "My Jobs",
  icon: "field",
  permission: "jobs:update_own",
  phase: 5,
  description: "Your assigned installations and maintenance jobs.",
};

export const PLATFORM_NAV: NavItem[] = [
  { href: "/admin", label: "Platform Overview", icon: "overview", permission: null, phase: 6, description: "FibrePulse business performance." },
  { href: "/admin/tenants", label: "ISP Tenants", icon: "tenants", permission: null, phase: 1, description: "Registered ISPs and their activation status." },
  { href: "/admin/agreements", label: "Agreements", icon: "agreements", permission: null, phase: 6, description: "Commercial agreements and fee rates per ISP." },
  { href: "/admin/invoices", label: "Platform Invoices", icon: "invoices", permission: null, phase: 6, description: "Platform fee calculations, invoices and unpaid balances." },
  { href: "/admin/support-access", label: "Support Access", icon: "shield", permission: null, phase: 6, description: "Owner-approved, time-limited support access requests." },
  { href: "/admin/audit", label: "Audit Log", icon: "audit", permission: null, phase: 6, description: "Administrative activity across the platform." },
];

export function visibleIspNav(permissions: ReadonlySet<Permission>): NavItem[] {
  const items = ISP_NAV.filter((i) => i.permission === null || permissions.has(i.permission));
  if (!permissions.has("jobs:view") && permissions.has("jobs:update_own")) {
    const at = items.findIndex((i) => i.href === "/reports");
    items.splice(at < 0 ? items.length : at, 0, TECHNICIAN_NAV);
  }
  return items;
}
