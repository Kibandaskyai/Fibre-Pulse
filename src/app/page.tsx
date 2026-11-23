import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";

export default async function Home() {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  if (ctx.active) redirect("/overview");
  if (ctx.platformRole) redirect("/admin");
  redirect("/onboarding");
}
