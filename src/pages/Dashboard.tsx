import { Helmet } from "react-helmet-async";
import DashboardLayout from "@/components/dashboard/DashboardLayout";

/**
 * /app route — the dashboard.
 *
 * Replaced on 2026-04-21 by DashboardLayout, a self-contained page that
 * ships its own sidebar + topbar + content panes. Because DashboardLayout
 * renders its own chrome, this page is deliberately pulled out of the
 * shared AppShell wrapper (see src/App.tsx) so we don't get two sidebars.
 *
 * Auth gating still runs — the ProtectedRoute wrapper in App.tsx guards
 * the /app URL and redirects unauthenticated visitors.
 */
export default function Dashboard() {
  return (
    <>
      <Helmet>
        <title>Dashboard | MotionMax</title>
        <meta name="description" content="Your MotionMax workspace — recent projects, render queue, and quick actions." />
      </Helmet>
      <DashboardLayout />
    </>
  );
}
