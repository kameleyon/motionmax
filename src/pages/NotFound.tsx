import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ThemedLogo } from "@/components/ThemedLogo";
import { Home, ArrowLeft, LayoutDashboard, FolderOpen, CreditCard, Settings } from "lucide-react";

const SUGGESTED_PAGES = [
  { to: "/app",      label: "Dashboard",  icon: LayoutDashboard },
  { to: "/projects", label: "Projects",   icon: FolderOpen },
  { to: "/pricing",  label: "Pricing",    icon: CreditCard },
  { to: "/settings", label: "Settings",   icon: Settings },
];

const NotFound = () => {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border/30 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-4">
          <Link to="/">
            <ThemedLogo className="h-8 w-auto" />
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-20">
        <div className="text-center space-y-6 max-w-md">
          <p className="text-8xl font-bold text-primary/20 select-none leading-none">404</p>

          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground">Page not found</h1>
            <p className="text-muted-foreground">
              The page you're looking for doesn't exist or has been moved.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button asChild>
              <Link to="/">
                <Home className="h-4 w-4 mr-2" />
                Go to Home
              </Link>
            </Button>
            <Button variant="outline" onClick={() => window.history.back()}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Go Back
            </Button>
          </div>

          {/* Quick suggestions */}
          <div className="pt-2 border-t border-border/30">
            <p className="text-xs text-muted-foreground mb-3">Looking for one of these?</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTED_PAGES.map(({ to, label, icon: Icon }) => (
                <Link
                  key={to}
                  to={to}
                  className="flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default NotFound;
