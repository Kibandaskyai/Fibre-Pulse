import { z } from "zod";

/**
 * Public configuration, safe for the browser. Only NEXT_PUBLIC_* values here.
 * Server-only secrets (service role key, Daraja keys, encryption keys) are
 * read in server modules that import "server-only" and are never listed here.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export type PublicEnv = z.infer<typeof publicSchema>;

let cached: PublicEnv | null = null;

export function publicEnv(): PublicEnv {
  if (cached) return cached;
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    // Supabase now issues "publishable" keys; older projects call it the anon key.
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });
  if (!parsed.success) {
    throw new Error(
      "FibrePulse is missing Supabase settings. Copy .env.example to .env.local and fill it in. " +
        parsed.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  }
  cached = parsed.data;
  return cached;
}
