import { createScopedLogger } from "@/lib/logger";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AdminRoute } from "@/components/AdminRoute";
import { AppShell } from "@/components/layout/AppShell";
import { lazy, Suspense } from "react";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { CookieConsent } from "./components/CookieConsent";

// Route-level code splitting — each page loads only when visited
const Landing = lazy(() => import("./pages/Landing"));
const Auth = lazy(() => import("./pages/Auth"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
// New dashboard under construction — lives at /dashboard-new until it's
// ready to replace the /app route entirely. Self-contained layout
// (Sidebar + topbar + main + RightRail) so it opts OUT of AppShell.
const DashboardLayout = lazy(() => import("./components/dashboard/DashboardLayout"));
const CreateWorkspace = lazy(() => import("./pages/CreateWorkspace"));
// Unified intake form — /app/create/new. Reuses the dashboard-new shell
// and feeds all three modes (cinematic/doc2video/smartflow) through a
// single shared form. Added alongside the existing CreateWorkspace so we
// don't break in-flight projects that depend on the old routes.
const CreateNew = lazy(() => import("./pages/CreateNew"));
// Unified Editor — post-intake surface that replaces the generation
// progress screen + legacy Result view + legacy CreateWorkspace. See
// player_editor_roadmap.md for the full rollout plan.
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
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<Auth />} />
            {/* Public share page - no auth required */}
            <Route path="/share/:token" element={<PublicShare />} />

            {/* Legacy authenticated app routes share AppShell
                (SidebarProvider + AppSidebar). Routes that own the
                NEW dashboard chrome (Projects, dashboard-new) live
                outside this wrapper to avoid stacking two sidebars. */}
            <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
              <Route path="/app" element={<RouteErrorBoundary routeName="dashboard"><Dashboard /></RouteErrorBoundary>} />
              <Route path="/app/create" element={<RouteErrorBoundary routeName="create"><CreateWorkspace /></RouteErrorBoundary>} />
              <Route path="/pricing" element={<Pricing />} />
            </Route>

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
