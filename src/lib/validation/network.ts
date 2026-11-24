import { isIP } from "node:net";
import { z } from "zod";

const optionalText = (max: number) =>
  z.string().trim().max(max, `Keep this under ${max} characters.`).transform((v) => (v === "" ? null : v)).prefault("");

const optionalNumber = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .prefault("")
    .transform((v, ctx) => {
      if (v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `${label} must be between ${min} and ${max}.` });
        return z.NEVER;
      }
      return n;
    });

const checkbox = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());

export const routerSchema = z.object({
  name: z.string().trim().min(2, "Give the router a name.").max(80),
  managementAddress: z
    .string()
    .trim()
    .prefault("")
    .refine((v) => v === "" || isIP(v) !== 0, "Enter the router's IP address on your network, for example 192.168.88.1.")
    .transform((v) => (v === "" ? null : v)),
  apiPort: optionalNumber("Port", 1, 65535).pipe(z.number().int("Port must be a whole number.").nullable()),
  apiScheme: z.enum(["https", "http"]).prefault("https"),
  verifyTls: checkbox,
  connectorAgentId: z
    .string()
    .prefault("")
    .refine((v) => v === "" || z.uuid().safeParse(v).success, "Choose a connector.")
    .transform((v) => (v === "" ? null : v)),
  locationName: optionalText(120),
  latitude: optionalNumber("Latitude", -5, 5.5),
  longitude: optionalNumber("Longitude", 33.5, 42),
  monitoringEnabled: checkbox,
  coverageRadiusM: optionalNumber("Coverage radius", 50, 50000).pipe(z.number().int("Use whole metres.").nullable()),
});
export type RouterInput = z.infer<typeof routerSchema>;

export const credentialsSchema = z.object({
  routerId: z.uuid(),
  username: z.string().trim().min(1, "Enter the API username.").max(64),
  password: z.string().min(1, "Enter the API password.").max(128),
});

export const connectorSchema = z.object({
  name: z.string().trim().min(2, "Give the connector a name, such as the site it runs at.").max(80),
});

export const alertActionSchema = z.object({
  alertId: z.uuid(),
  action: z.enum(["acknowledge", "resolve"]),
  note: optionalText(300),
});

export const customerRouterSchema = z.object({
  customerId: z.uuid(),
  routerId: z
    .string()
    .prefault("")
    .refine((v) => v === "" || z.uuid().safeParse(v).success, "Choose a router.")
    .transform((v) => (v === "" ? null : v)),
});
