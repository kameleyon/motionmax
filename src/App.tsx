import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/layout/AppShell";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import CreateWorkspace from "./pages/CreateWorkspace";
import Settings from "./pages/Settings";
import Usage from "./pages/Usage";
import Pricing from "./pages/Pricing";
import Projects from "./pages/Projects";
import VoiceLab from "./pages/VoiceLab";
import PublicShare from "./pages/PublicShare";
import Admin from "./pages/Admin";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import AcceptableUse from "./pages/AcceptableUse";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
      <TooltipProvider>
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<Auth />} />
            {/* Public share page - no auth required */}
            <Route path="/share/:token" element={<PublicShare />} />

            {/* Authenticated routes using shared AppShell (SidebarProvider + AppSidebar) */}
            <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
              <Route path="/app" element={<Dashboard />} />
              <Route path="/app/create" element={<CreateWorkspace />} />
              <Route path="/pricing" element={<Pricing />} />
            </Route>

            {/* Pages that manage their own SidebarProvider with sidebar state */}
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/usage" element={<ProtectedRoute><Usage /></ProtectedRoute>} />
            <Route path="/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
            <Route path="/voice-lab" element={<ProtectedRoute><VoiceLab /></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />

            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/acceptable-use" element={<AcceptableUse />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
