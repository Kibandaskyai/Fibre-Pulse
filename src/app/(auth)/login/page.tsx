import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Welcome back to your ISP workspace.</p>
      <LoginForm next={next} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to FibrePulse?{" "}
        <Link href="/signup" className="text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
