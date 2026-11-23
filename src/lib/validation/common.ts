import { z } from "zod";

/**
 * Kenyan phone numbers are stored in E.164 form (+2547XXXXXXXX or
 * +2541XXXXXXXX). Accepts 07..., 01..., 7..., 2547..., +2547...
 */
export function normaliseKenyanPhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, "");
  let m = digits.match(/^\+?254([17]\d{8})$/);
  if (m) return `+254${m[1]}`;
  m = digits.match(/^0([17]\d{8})$/);
  if (m) return `+254${m[1]}`;
  m = digits.match(/^([17]\d{8})$/);
  if (m) return `+254${m[1]}`;
  return null;
}

export const kenyanPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normaliseKenyanPhone(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a Kenyan mobile number, for example 0712 345 678." });
      return z.NEVER;
    }
    return n;
  });

export const optionalKenyanPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === "") return null;
    const n = normaliseKenyanPhone(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a Kenyan mobile number, for example 0712 345 678." });
      return z.NEVER;
    }
    return n;
  });

export const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")).pipe(z.string().max(254));

/** The 47 counties of Kenya, for address and tenant forms. */
export const KENYAN_COUNTIES = [
  "Baringo", "Bomet", "Bungoma", "Busia", "Elgeyo-Marakwet", "Embu", "Garissa", "Homa Bay", "Isiolo", "Kajiado",
  "Kakamega", "Kericho", "Kiambu", "Kilifi", "Kirinyaga", "Kisii", "Kisumu", "Kitui", "Kwale", "Laikipia", "Lamu",
  "Machakos", "Makueni", "Mandera", "Marsabit", "Meru", "Migori", "Mombasa", "Murang'a", "Nairobi", "Nakuru", "Nandi",
  "Narok", "Nyamira", "Nyandarua", "Nyeri", "Samburu", "Siaya", "Taita-Taveta", "Tana River", "Tharaka-Nithi",
  "Trans Nzoia", "Turkana", "Uasin Gishu", "Vihiga", "Wajir", "West Pokot",
] as const;

/** Result shape every server action returns to its form. */
export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
