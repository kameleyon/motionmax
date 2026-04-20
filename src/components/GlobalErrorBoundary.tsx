import { Component, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { handleChunkError } from "@/lib/chunkReload";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class GlobalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[GlobalErrorBoundary] Uncaught error:", error, errorInfo);
    Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
    // Auto-reload on stale chunk errors (happens after a new deployment)
    handleChunkError(error, "global_chunk_reload");
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-6">
          <div className="max-w-md w-full text-center space-y-6">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>

            <div className="space-y-2">
              <h1 className="type-h1 text-foreground">Something went wrong</h1>
              <p className="type-body text-muted-foreground">
                An unexpected error occurred. This has been logged and we're looking into it.
              </p>
            </div>

            {this.state.error && (
              <div className="rounded-xl border border-border/50 bg-muted/30 p-4 text-left">
                <p className="type-caption font-mono break-all">
                  {this.state.error.message}
                </p>
              </div>
            )}

            <div className="flex items-center justify-center gap-3">
              <Button
                size="lg"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
                className="gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                Try Again
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.href = "/";
                }}
                className="gap-2"
              >
                <Home className="h-4 w-4" />
                Go Home
              </Button>
            </div>

            <p className="type-caption">
              If this keeps happening, please contact support at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">
                support@motionmax.io
              </a>
            </p>

            <button
              onClick={() => {
                // Open Sentry user feedback dialog if available
                try {
                  const feedbackIntegration = Sentry.getClient()?.getIntegrationByName?.("Feedback");
                  if (feedbackIntegration && typeof (feedbackIntegration as { openDialog?: () => void }).openDialog === "function") {
                    (feedbackIntegration as { openDialog: () => void }).openDialog();
                  } else {
                    window.open("mailto:support@motionmax.io?subject=Error Report", "_blank");
                  }
                } catch {
                  window.open("mailto:support@motionmax.io?subject=Error Report", "_blank");
                }
              }}
              className="text-xs text-muted-foreground underline hover:text-foreground mt-1"
            >
              Send feedback
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
