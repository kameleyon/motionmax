import { cn } from "@/lib/utils";

interface BillingToggleProps {
  value: "monthly" | "yearly";
  onChange: (value: "monthly" | "yearly") => void;
  discountPercent?: number;
  className?: string;
}

export function BillingToggle({ value, onChange, discountPercent, className }: BillingToggleProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-3 rounded-full bg-muted/50 p-1 border border-border/30",
        className
      )}
      role="group"
      aria-label="Billing interval"
    >
      <button
        onClick={() => onChange("monthly")}
        aria-pressed={value === "monthly"}
        className={cn(
          "px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
          value === "monthly"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        Monthly
      </button>
      <button
        onClick={() => onChange("yearly")}
        aria-pressed={value === "yearly"}
        className={cn(
          "px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
          value === "yearly"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        Yearly
        {discountPercent != null && discountPercent > 0 && (
          <span className="ml-1.5 text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
            Save {discountPercent}%
          </span>
        )}
      </button>
    </div>
  );
}
