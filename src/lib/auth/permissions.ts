/**
 * FibrePulse permission matrix.
 *
 * This is the single TypeScript definition of what each ISP role may do. The
 * database holds the same matrix in `private.role_permissions` (migration
 * 0003) and enforces it through Row Level Security. The test
 * `tests/db/permissions-sync.test.ts` fails if the two ever differ.
 *
 * The UI uses this to decide what to show. The server uses it to reject
 * requests early with a clear message. The database is the final authority.
 */

export const TENANT_ROLES = [
  "owner",
  "finance",
  "network_admin",
  "support_agent",
  "technician",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const PLATFORM_ROLES = ["super_admin", "support_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PERMISSIONS = [
  "staff:manage",
  "settings:manage",
  "audit:view",
  "customers:view",
  "customers:edit",
  "customers:view_location",
  "packages:view",
  "packages:edit",
  "subscriptions:view",
  "subscriptions:edit",
  "subscriptions:suspend",
  "invoices:view",
  "invoices:edit",
  "payments:view",
  "payments:record",
  "payments:reconcile",
  "revenue:view",
  "network:view",
  "network:edit",
  "network:credentials",
  "alerts:view",
  "alerts:manage",
  "tickets:view",
  "tickets:edit",
  "jobs:view",
  "jobs:edit",
  "jobs:update_own",
  "reports:financial",
  "reports:network",
  "reports:support",
  "platform_billing:view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  owner: [
    "staff:manage",
    "settings:manage",
    "audit:view",
    "customers:view",
    "customers:edit",
    "customers:view_location",
    "packages:view",
    "packages:edit",
    "subscriptions:view",
    "subscriptions:edit",
    "subscriptions:suspend",
    "invoices:view",
    "invoices:edit",
    "payments:view",
    "payments:record",
    "payments:reconcile",
    "revenue:view",
    "network:view",
    "network:edit",
    "network:credentials",
    "alerts:view",
    "alerts:manage",
    "tickets:view",
    "tickets:edit",
    "jobs:view",
    "jobs:edit",
    "reports:financial",
    "reports:network",
    "reports:support",
    "platform_billing:view",
  ],
  finance: [
    "customers:view",
    "packages:view",
    "subscriptions:view",
    "invoices:view",
    "invoices:edit",
    "payments:view",
    "payments:record",
    "payments:reconcile",
    "revenue:view",
    "reports:financial",
    "tickets:view",
    "platform_billing:view",
  ],
  network_admin: [
    "customers:view",
    "customers:view_location",
    "packages:view",
    "subscriptions:view",
    "network:view",
    "network:edit",
    "network:credentials",
    "alerts:view",
    "alerts:manage",
    "tickets:view",
    "tickets:edit",
    "jobs:view",
    "jobs:edit",
    "reports:network",
  ],
  support_agent: [
    "customers:view",
    "packages:view",
    "subscriptions:view",
    "network:view",
    "alerts:view",
    "tickets:view",
    "tickets:edit",
    "jobs:view",
    "jobs:edit",
    "reports:support",
  ],
  technician: ["network:view", "alerts:view", "jobs:update_own"],
};

export const ROLE_LABELS: Record<TenantRole, string> = {
  owner: "ISP Owner",
  finance: "Finance Manager",
  network_admin: "Network Administrator",
  support_agent: "Customer Support Agent",
  technician: "Field Technician",
};

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  super_admin: "Super Administrator",
  support_admin: "Support Administrator",
};

export function roleHasPermission(role: TenantRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(role: TenantRole | null | undefined): ReadonlySet<Permission> {
  return new Set(role ? ROLE_PERMISSIONS[role] : []);
}

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && (TENANT_ROLES as readonly string[]).includes(value);
}

/** Roles an owner may assign through an invitation (ownership is never invited). */
export const INVITABLE_ROLES = TENANT_ROLES.filter((r) => r !== "owner");
