// App-level error boundary. Mounted from AppShell so any thrown
// render error shows a recovery screen with the message and a
// reload button instead of a white screen. Phase 18 #21.
//
// React error boundaries can only be class components — there's no
// hook equivalent. The component is intentionally minimal: it does
// not phone home (telemetry is disallowed by the product
// invariants), it just surfaces the failure so the operator can act.

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  showStack: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, showStack: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local logging only. We do not ship errors anywhere — see
    // CLAUDE.md "no telemetry" invariant. Operators can still copy
    // the visible message + stack from the recovery screen.
    // eslint-disable-next-line no-console
    console.error('app error boundary caught', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null, showStack: false });
  };

  override render(): ReactNode {
    const { error, showStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-screen place-items-center bg-surface p-6">
        <div className="w-full max-w-xl space-y-4 rounded-lg border border-surface-muted bg-white p-6 shadow-sm">
          <div>
            <h1 className="text-lg font-semibold text-danger">Something went wrong</h1>
            <p className="mt-1 text-sm text-ink-muted">
              The page crashed while rendering. Try again, and if it keeps happening, copy the
              message below for the operator log.
            </p>
          </div>
          <pre className="max-h-40 overflow-auto rounded-md bg-surface-subtle p-3 font-mono text-xs">
            {error.message}
          </pre>
          {showStack && error.stack ? (
            <pre className="max-h-60 overflow-auto rounded-md border border-surface-muted bg-surface-subtle p-3 font-mono text-[11px] text-ink-muted">
              {error.stack}
            </pre>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => this.setState({ showStack: !showStack })}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-xs"
            >
              {showStack ? 'Hide stack' : 'Show stack'}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={this.reset}
                className="rounded-md border border-surface-muted px-3 py-1.5 text-sm"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
