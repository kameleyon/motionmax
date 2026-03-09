import { Component, type ReactNode, type ErrorInfo } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary that catches unhandled JS errors in workspace components.
 * Without this, any async error in the generation pipeline could crash the entire app.
 */
export class WorkspaceErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[WorkspaceErrorBoundary] Caught error:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-7 w-7 text-destructive" />
            </div>
          </div>
          <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">
            An unexpected error occurred in the workspace. Your progress may have been saved.
          </p>
          {this.state.error && (
            <p className="text-xs text-muted-foreground/60 font-mono bg-muted/50 rounded-lg px-3 py-2 text-left break-all">
              {this.state.error.message}
            </p>
          )}
          <div className="flex gap-3 justify-center">
            <Button onClick={this.handleReset} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Try Again
            </Button>
            <Button variant="outline" onClick={() => window.location.assign("/app")}>
              Go to Dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
