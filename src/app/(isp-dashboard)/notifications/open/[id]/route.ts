import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/security/redirect";

/** Marks a notification read and goes to what it is about. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createClient();
  const { data: claims } = await db.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.redirect(new URL("/notifications", request.url));
  const { data } = await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("recipient_id", userId).select("link").maybeSingle();
  // RLS already limits this to the person's own notifications; links are stored as same-site paths.
  const target = safeNextPath(data?.link, "/notifications");
  return NextResponse.redirect(new URL(target, request.url));
}
