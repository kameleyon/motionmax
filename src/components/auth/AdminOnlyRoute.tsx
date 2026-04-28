import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAdminAuth } from "@/hooks/useAdminAuth";

/**
 * Route guard for the `/lab/*` admin sandbox.
 *
 * Semantically distinct from `<AdminRoute>` (which guards `/admin/*`)
 * even though both currently delegate to `useAdminAuth()`. When the
 * autopost feature graduates from soft launch we will change the gate
 * here from `is_admin` to `plan === 'studio_pro' && autopost_enabled`
 * without touching the production `/admin/*` wrapper.
 *
 * Behavior:
 *   - shows a centered spinner while the auth/role lookup resolves
 *   - logged-out users are sent to `/auth`
 *   - logged-in non-admins are sent to `/app`
 *   - admins see the wrapped children
 */
export function AdminOnlyRoute({ children }: { children: ReactNode }) {
  const { isAdmin, loading, user } = useAdminAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;
  if (!isAdmin) return <Navigate to="/app" replace />;

  return <>{children}</>;
}

export default AdminOnlyRoute;
