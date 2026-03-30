import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
        /** Warning — uses the design-system --warning token */
        warning: "border-transparent bg-warning text-warning-foreground hover:bg-warning/80",
        /** Success — uses the design-system --success token */
        success: "border-transparent bg-success text-success-foreground hover:bg-success/80",
        /** Outline variants for colored legend badges */
        "outline-primary": "border-primary text-primary",
        "outline-destructive": "border-destructive text-destructive",
        "outline-warning": "border-warning text-warning",
        "outline-success": "border-success text-success",
        "outline-muted": "border-muted-foreground text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
