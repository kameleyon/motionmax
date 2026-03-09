import { Navigate, useLocation } from "react-router-dom";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AdminRouteProps {
  children: React.ReactNode;
}

/**
 * Route guard for admin-only pages. Auth + admin check both resolve here
 * before any admin page code is loaded — non-admins never execute admin JS.
 */
export function AdminRoute({ children }: AdminRouteProps) {
  const { isAdmin, loading, user } = useAdminAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    const returnUrl = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/auth?returnUrl=${returnUrl}`} replace />;
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="h-7 w-7 text-destructive" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">Access Denied</h1>
        <p className="text-sm text-muted-foreground max-w-xs text-center">
          You don't have permission to access the admin panel.
        </p>
        <Button variant="outline" onClick={() => window.location.assign("/app")}>
          Go to Dashboard
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
