"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
import { safeNextPath } from "@/lib/security/redirect";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import { forgotPasswordSchema, resetPasswordSchema, signInSchema, signUpSchema } from "@/lib/validation/auth";

// Supabase Auth applies its own rate limits to sign-in, sign-up and
// password reset. See docs/SECURITY_GUIDE.md for production settings.

export async function signInAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
  if (error) {
    // One message for every failure so attackers cannot tell which emails exist.
    return { ok: false, message: "Email or password is incorrect, or the email is not confirmed yet." };
  }
  redirect(safeNextPath(parsed.data.next, "/overview"));
}

export async function signUpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };

  const supabase = await createClient();
  const origin = (await headers()).get("origin") ?? publicEnv().NEXT_PUBLIC_SITE_URL;
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${origin}/auth/callback?next=/onboarding`,
    },
  });
  if (error) {
    if (error.code === "weak_password") return { ok: false, message: error.message };
    return { ok: false, message: "Could not create the account. Please try again." };
  }
  // When email confirmation is on (production), there is no session yet.
  if (!data.session) {
    return { ok: true, message: "Check your email for a confirmation link, then sign in." };
  }
  redirect("/onboarding");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function forgotPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = forgotPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
  const supabase = await createClient();
  const origin = (await headers()).get("origin") ?? publicEnv().NEXT_PUBLIC_SITE_URL;
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });
  // Same answer whether or not the email exists.
  return { ok: true, message: "If that email has an account, a reset link is on its way." };
}

export async function resetPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = resetPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { ok: false, message: "Could not update the password. The reset link may have expired." };
  redirect("/overview");
}
