import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotAllowedPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <ShieldAlert className="size-10 text-warning" aria-hidden />
      <h1 className="text-xl font-semibold">You do not have access to this page</h1>
      <p className="max-w-md text-sm text-muted-foreground">Your role does not include this area. Ask your ISP owner if you need access.</p>
      <Button asChild variant="outline">
        <Link href="/">Go to my dashboard</Link>
      </Button>
    </div>
  );
}
