import { Component, type ReactNode, type ErrorInfo } from "react";
import * as Sentry from "@sentry/react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AdminTabBoundaryProps {
  /** Tab key (e.g. `'overview' | 'analytics' | ...`) — used as the Sentry tag. */
  tabKey: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Per-admin-tab error boundary. Isolates render errors to a single tab so
 * one failing query doesn't kill the whole admin shell. Reports to Sentry
 * with `tags: { tab: <tabKey> }` for fast triage and renders a small inline
 * error card with a retry button so the admin can recover without reload.
 */
export class AdminTabBoundary extends Component<AdminTabBoundaryProps, State> {
  constructor(props: AdminTabBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    Sentry.captureException(error, {
      tags: { tab: this.props.tabKey },
      extra: { componentStack: info.componentStack },
    });
    if (typeof console !== "undefined") {
      console.error(
        `[AdminTabBoundary:${this.props.tabKey}] uncaught error`,
        error,
        info,
      );
    }
  }

  componentDidUpdate(prevProps: AdminTabBoundaryProps) {
    // Reset when the user switches to a different tab.
    if (prevProps.tabKey !== this.props.tabKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const message = this.state.error?.message ?? "Unknown error";
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] p-5 text-left"
        style={{ maxWidth: 560 }}
      >
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(245,176,73,0.12)] text-[var(--warn)]">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-medium text-[var(--ink)]">
              This tab hit an error
            </div>
            <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
              tab · {this.props.tabKey}
            </div>
          </div>
        </div>
        <p className="break-all font-mono text-[11px] text-[var(--ink-dim)]">
          {message}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={this.handleRetry}
          className="gap-2"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }
}
