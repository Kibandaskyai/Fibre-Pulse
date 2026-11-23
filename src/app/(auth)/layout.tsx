import { Brand } from "@/components/layout/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="relative hidden overflow-hidden border-r bg-sidebar lg:flex lg:flex-col lg:justify-between lg:p-10">
        <Brand subtitle="ISP operations and intelligence" />
        <div>
          <p className="max-w-md text-3xl font-semibold leading-tight tracking-tight">
            See your network.
            <br />
            Understand your revenue.
            <br />
            <span className="text-accent">Grow your ISP.</span>
          </p>
          <p className="mt-4 max-w-md text-sm text-muted-foreground">
            Customers, subscriptions, M-Pesa collections and MikroTik network health in one secure workspace for Kenyan fibre ISPs.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">Your data stays in your ISP workspace. FibrePulse staff cannot see it without your approval.</p>
        <div aria-hidden className="pointer-events-none absolute -right-24 top-1/3 size-96 rounded-full bg-primary/10 blur-3xl" />
      </div>
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Brand />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
