import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-3.5 [&>svg]:size-4 [&>svg~*]:pl-7", {
  variants: {
    variant: {
      default: "bg-card text-foreground",
      info: "border-primary/30 bg-primary/10 text-foreground [&>svg]:text-primary",
      success: "border-success/30 bg-success/10 text-foreground [&>svg]:text-success",
      warning: "border-warning/30 bg-warning/10 text-foreground [&>svg]:text-warning",
      danger: "border-danger/30 bg-danger/10 text-foreground [&>svg]:text-danger",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Alert({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn("mb-1 font-medium leading-none", className)} {...props} />;
}
export function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <div className={cn("text-sm text-muted-foreground [&_p]:leading-relaxed", className)} {...props} />;
}
