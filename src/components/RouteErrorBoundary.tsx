import { Component, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  routeName: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Per-route error boundary — isolates crashes to a single route so the
 * rest of the app (sidebar, other pages) stays functional.
 *
 * Wraps individual authenticated routes in App.tsx. Reports to Sentry
 * with the route name tag for fast triage.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    Sentry.captureException(error, {
      tags: { route: this.props.routeName },
      extra: { componentStack: info.componentStack },
    });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">
            This page ran into an error
          </h2>
          <p className="text-sm text-muted-foreground">
            The rest of the app is still working.{" "}
            <a href="mailto:support@motionmax.io" className="text-primary hover:underline">
              Contact support
            </a>{" "}
            if it keeps happening.
          </p>
        </div>
        {this.state.error && (
          <p className="text-xs font-mono text-muted-foreground/70 break-all max-w-sm">
            {this.state.error.message}
          </p>
        )}
        <Button
          size="sm"
          className="gap-2"
          onClick={() => this.setState({ hasError: false, error: null })}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      </div>
    );
  }
}
