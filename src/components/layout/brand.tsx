import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * FibrePulse brand. The logo artwork has a white background, so on the dark
 * theme it always sits on a white tile or card rather than being recoloured.
 */

/** Compact mark (the "F" with the revenue bars) on a white tile, for tight spaces. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-white/10", className)}>
      <Image src="/brand/fibrepulse-mark.png" alt="" width={64} height={64} className="size-full object-contain" priority />
    </span>
  );
}

/** Mark plus the product name, for the sidebar and page headers. */
export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">FibrePulse</span>
        {subtitle ? <span className="block max-w-40 truncate text-[11px] text-muted-foreground">{subtitle}</span> : null}
      </span>
    </div>
  );
}

/** The full logo with its tagline on a white card, for sign-in and registration. */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <div className={cn("inline-block rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-white/10", className)}>
      <Image
        src="/brand/fibrepulse-logo.png"
        alt="FibrePulse: revenue monitoring for ISPs"
        width={1200}
        height={330}
        className="h-auto w-full"
        priority
      />
    </div>
  );
}
