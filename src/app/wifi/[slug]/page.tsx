import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { cleanMac, safeHotspotLoginUrl } from "@/lib/hotspot-login";
import { BuyWifi, type PortalInfo } from "./buy-wifi";

export const dynamic = "force-dynamic";

async function portal(slug: string): Promise<PortalInfo | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null;
  const env = publicEnv();
  const db = createSupabase(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await db.rpc("hotspot_portal", { p_slug: slug });
  return (data as PortalInfo | null) ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const info = await portal((await params).slug);
  return { title: info ? `${info.name} WiFi` : "WiFi" };
}

/**
 * The page people see on the hotspot before they have internet. MikroTik's
 * login page redirects here with ?mac=…&link-login-only=…&dst=… (see
 * docs/MIKROTIK_INTEGRATION.md); the FibrePulse address must be in the
 * hotspot's walled garden.
 */
export default async function WifiPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const info = await portal(slug);
  if (!info) notFound();
  return (
    <main className="min-h-dvh bg-background px-4 py-6 text-foreground">
      <BuyWifi
        slug={slug}
        info={info}
        mac={cleanMac(sp.mac)}
        loginUrl={safeHotspotLoginUrl(sp["link-login-only"] ?? sp.login)}
        dst={(sp.dst ?? "").slice(0, 500)}
        error={(sp.error ?? "").slice(0, 200)}
      />
    </main>
  );
}
