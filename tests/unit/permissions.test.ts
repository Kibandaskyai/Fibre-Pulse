import { describe, expect, it } from "vitest";
import { INVITABLE_ROLES, PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission, TENANT_ROLES } from "@/lib/auth/permissions";
import { visibleIspNav } from "@/components/layout/nav-config";
import { permissionsForRole } from "@/lib/auth/permissions";

describe("permission matrix", () => {
  it("only uses known permission names", () => {
    for (const role of TENANT_ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });

  it("gives the owner every ISP permission except technician self-service", () => {
    const missing = PERMISSIONS.filter((p) => !ROLE_PERMISSIONS.owner.includes(p));
    expect(missing).toEqual(["jobs:update_own"]);
  });

  it("keeps finance away from network credentials and staff management (spec 3.1)", () => {
    expect(roleHasPermission("finance", "network:credentials")).toBe(false);
    expect(roleHasPermission("finance", "staff:manage")).toBe(false);
    expect(roleHasPermission("finance", "payments:record")).toBe(true);
  });

  it("never lets anyone but owner and network admin set router credentials", () => {
    const roles = TENANT_ROLES.filter((r) => roleHasPermission(r, "network:credentials"));
    expect(roles.sort()).toEqual(["network_admin", "owner"]);
  });

  it("does not allow ownership through invitations", () => {
    expect(INVITABLE_ROLES).not.toContain("owner");
  });

  it("handles a missing role safely", () => {
    expect(roleHasPermission(null, "customers:view")).toBe(false);
  });
});

describe("navigation", () => {
  const labels = (role: (typeof TENANT_ROLES)[number]) => visibleIspNav(permissionsForRole(role)).map((i) => i.label);

  it("shows the owner all 14 main sections, Hotspot included", () => {
    expect(labels("owner")).toHaveLength(14);
    expect(labels("owner")[1]).toBe("Hotspot");
  });

  it("hides money from network admins and the network from finance", () => {
    expect(labels("network_admin")).not.toContain("Payments");
    expect(labels("network_admin")).not.toContain("Revenue");
    expect(labels("finance")).not.toContain("Network Monitoring");
  });

  it("gives technicians a My Jobs entry instead of Field Operations", () => {
    expect(labels("technician")).toContain("My Jobs");
    expect(labels("technician")).not.toContain("Customers");
  });
});
