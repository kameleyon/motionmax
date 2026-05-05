import { createScopedLogger } from "@/lib/logger";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AdminRoute } from "@/components/AdminRoute";
import { AdminOnlyRoute } from "@/components/auth/AdminOnlyRoute";
import { SubscriptionRenewalModal } from "@/components/workspace/SubscriptionRenewalModal";
import { V2AnnouncementModal } from "@/components/announcements/V2AnnouncementModal";
import { lazy, Suspense } from "react";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { CookieConsent } from "./components/CookieConsent";

// Route-level code splitting — each page loads only when visited
const Landing = lazy(() => import("./pages/Landing"));
const Auth = lazy(() => import("./pages/Auth"));
// Legacy `Dashboard` + `CreateWorkspace` (WorkspaceRouter) retired
// 2026-05-04 alongside the BetaRebuildBanner sunset. The surviving
// surfaces are DashboardLayout (/dashboard-new) and CreateNew
// (/app/create/new) — the former renders the new dashboard, the
// latter the unified intake form. Old /app/* URLs redirect.
const DashboardLayout = lazy(() => import("./components/dashboard/DashboardLayout"));
const CreateNew = lazy(() => import("./pages/CreateNew"));
const Editor = lazy(() => import("./pages/Editor"));
const Settings = lazy(() => import("./pages/Settings"));
const Usage = lazy(() => import("./pages/Usage"));
const Pricing = lazy(() => import("./pages/Pricing"));
const Projects = lazy(() => import("./pages/Projects"));
const VoiceLab = lazy(() => import("./pages/VoiceLab"));
const PublicShare = lazy(() => import("./pages/PublicShare"));
const Terms = lazy(() => import("./pages/Terms"));
const Privacy = lazy(() => import("./pages/Privacy"));
const AcceptableUse = lazy(() => import("./pages/AcceptableUse"));
const NotFound = lazy(() => import("./pages/NotFound"));

// Admin page in its own chunk — never loaded for non-admin users
const Admin = lazy(() => import(/* webpackChunkName: "admin" */ "./pages/Admin"));

// Lab (admin-only soft-launch sandbox) — autopost feature scaffolds.
// Each page lazy-loads independently so unrelated changes don't grow
// the main bundle. Gated by <AdminOnlyRoute>; never linked from main nav.
const LabHome = lazy(() => import("./pages/lab/LabHome"));
const AutopostHome = lazy(() => import("./pages/lab/autopost/AutopostHome"));
const RunHistory = lazy(() => import("./pages/lab/autopost/RunHistory"));
const RunDetail = lazy(() => import("./pages/lab/autopost/RunDetail"));

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

const log = createScopedLogger("QueryClient");

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => log.error('[Query]', error),
  }),
  mutationCache: new MutationCache({
    onError: (error) => log.error('[Mutation]', error),
  }),
});

const App = () => (
  <GlobalErrorBoundary>
  <AuthProvider>
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
      <TooltipProvider>
        <Sonner />
        <CookieConsent />
        <BrowserRouter>
          <Suspense fallback={<PageLoader />}>
          {/* Renewal nag was previously mounted inside the legacy
              AppShell. With AppShell retired, mount it globally so it
              still triggers on every authenticated surface. Must live
              INSIDE BrowserRouter — it calls useNavigate(). */}
          <SubscriptionRenewalModal />
          {/* v2.0 announcement — shows on every login until the user
              checks "Don't show this again" (per-user flag on profiles).
              Self-skips on /, /auth, /share/*, /legal/*. */}
          <V2AnnouncementModal />
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<Auth />} />
            {/* Public share page - no auth required */}
            <Route path="/share/:token" element={<PublicShare />} />

            {/* Legacy /app/* routes — all redirect now that the
                BetaRebuild banner has expired and the legacy AppShell
                + WorkspaceRouter were retired (2026-05-04). External
                bookmarks / OAuth callbacks still hit /app, and old
                "Create video" links hit /app/create — both bounce to
                their new-shell equivalents. */}
            <Route path="/app" element={<Navigate to="/dashboard-new" replace />} />
            <Route path="/app/legacy" element={<Navigate to="/dashboard-new" replace />} />
            <Route path="/app/create" element={<Navigate to="/app/create/new" replace />} />

            <Route path="/pricing" element={<Pricing />} />

            {/* Projects + Voice Lab + Settings + Usage render their own
                NEW AppShell (dashboard sidebar + topbar), so they must
                NOT be nested inside the legacy AppShell wrapper above
                — that would mount AppSidebar AND the new Sidebar side
                by side. */}
            <Route
              path="/projects"
              element={
                <ProtectedRoute>
                  <RouteErrorBoundary routeName="projects">
                    <Projects />
                  </RouteErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route
              path="/voice-lab"
              element={
                <ProtectedRoute>
                  <RouteErrorBoundary routeName="voice-lab">
                    <VoiceLab />
                  </RouteErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <RouteErrorBoundary routeName="settings">
                    <Settings />
                  </RouteErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route
              path="/usage"
              element={
                <ProtectedRoute>
                  <RouteErrorBoundary routeName="usage">
                    <Usage />
                  </RouteErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route path="/admin" element={<AdminRoute><RouteErrorBoundary routeName="admin"><Admin /></RouteErrorBoundary></AdminRoute>} />

            {/* Lab — autopost is now GA for any authenticated user.
                The plan gate (free vs Creator/Studio/Enterprise) is
                enforced inside the page itself + at the DB layer via
                the is_creator_or_studio RLS check, so all we need at
                the route layer is "must be signed in". /lab itself
                stays AdminOnlyRoute because LabHome is still the
                internal sandbox index — only /lab/autopost and its
                children are user-facing. */}
            <Route path="/lab" element={<AdminOnlyRoute><RouteErrorBoundary routeName="lab"><LabHome /></RouteErrorBoundary></AdminOnlyRoute>} />
            <Route path="/lab/autopost" element={<ProtectedRoute><RouteErrorBoundary routeName="lab-autopost"><AutopostHome /></RouteErrorBoundary></ProtectedRoute>} />
            {/* Connect moved to Settings → Integrations (Wave B2). */}
            <Route path="/lab/autopost/connect" element={<Navigate to="/settings?tab=integrations" replace />} />
            {/* Schedule CRUD now happens inline on /lab/autopost via the
                AutomationCard modals; redirect any old bookmarks. */}
            <Route path="/lab/autopost/schedules" element={<Navigate to="/lab/autopost" replace />} />
            <Route path="/lab/autopost/schedules/new" element={<Navigate to="/lab/autopost" replace />} />
            <Route path="/lab/autopost/schedules/:id" element={<Navigate to="/lab/autopost" replace />} />
            <Route path="/lab/autopost/runs" element={<ProtectedRoute><RouteErrorBoundary routeName="lab-autopost-runs"><RunHistory /></RouteErrorBoundary></ProtectedRoute>} />
            <Route path="/lab/autopost/runs/:id" element={<ProtectedRoute><RouteErrorBoundary routeName="lab-autopost-run-detail"><RunDetail /></RouteErrorBoundary></ProtectedRoute>} />

            {/* New dashboard preview — outside AppShell so its own
                Sidebar/topbar don't stack with AppSidebar. Still
                auth-gated by ProtectedRoute. Delete this route once
                DashboardLayout graduates and replaces /app. */}
            <Route
              path="/dashboard-new"
              element={
                <ProtectedRoute>
                  <RouteErrorBoundary routeName="dashboard-new">
                    <DashboardLayout />
                  </RouteErrorBoundary>
                </ProtectedRoute>
              }
            />

            {/* New unified intake form. Sits outside AppShell because it
                reuses the dashboard-new Sidebar + topbar as its own shell
                (via IntakeFrame). Auth-gated by ProtectedRoute. */}
            <Route
              path="/app/create/new"
              element={
                <ProtectedRoute>
                  <RouteErrorBoundary routeName="create-new">
                    <CreateNew />
                  </RouteErrorBoundary>
                </ProtectedRoute>
              }
            />

            {/* Unified Editor — generation screen + player + editor in one. */}
            <Route
              path="/app/editor/:projectId"
              element={
                <ProtectedRoute>
                  <RouteErrorBoundary routeName="editor">
                    <Editor />
                  </RouteErrorBoundary>
                </ProtectedRoute>
              }
            />

            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/acceptable-use" element={<AcceptableUse />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
  </AuthProvider>
  </GlobalErrorBoundary>
);

export default App;
