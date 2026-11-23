import { z } from "zod";
import { INVITABLE_ROLES, TENANT_ROLES } from "@/lib/auth/permissions";
import { email, KENYAN_COUNTIES, optionalKenyanPhone } from "./common";

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, "Use 3 to 48 lowercase letters, numbers or hyphens.");

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents: ũ -> u
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export const registerTenantSchema = z.object({
  name: z.string().trim().min(2, "Enter the ISP's name.").max(120),
  slug: slugSchema,
  county: z.enum(KENYAN_COUNTIES, { message: "Choose a county." }),
  town: z.string().trim().max(80).optional().default(""),
  contactPhone: optionalKenyanPhone,
  ownerName: z.string().trim().max(120).optional().default(""),
});
export type RegisterTenantInput = z.infer<typeof registerTenantSchema>;

export const inviteStaffSchema = z.object({
  email,
  role: z.enum(INVITABLE_ROLES as unknown as [string, ...string[]], { message: "Choose a role." }),
});

export const changeRoleSchema = z.object({
  memberId: z.uuid(),
  role: z.enum(TENANT_ROLES, { message: "Choose a role." }),
});

export const memberStatusSchema = z.object({
  memberId: z.uuid(),
  status: z.enum(["active", "disabled"]),
});

export const organisationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).optional().default(""),
  county: z.enum(KENYAN_COUNTIES, { message: "Choose a county." }),
  town: z.string().trim().max(80).optional().default(""),
  contactPhone: optionalKenyanPhone,
});
