import { Skeleton } from "@/components/ui/skeleton";

/**
 * Page-level loading skeleton for admin views.
 * Use instead of spinners so the layout is preserved while data loads.
 */
export function AdminLoadingState() {
  return (
    <div className="space-y-6 py-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
