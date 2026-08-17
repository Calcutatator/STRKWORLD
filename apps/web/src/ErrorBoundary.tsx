import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A last line so one thrown render does not white-screen the whole city.
 *
 * It also gives the deliberate production throw somewhere to land: a build that
 * reaches for the practice seam refuses on purpose (see `PrivacyProvider`), and
 * a bare unhandled throw would be a blank page rather than an explanation. The
 * boundary shows the message the thrown error carried when there is one, so
 * "not wired for production yet" reads as an intent, not a crash.
 *
 * A class component because that is the only thing React lets catch a render
 * error; there is no hook equivalent.
 */
export class ErrorBoundary extends Component<
  { fallback: (message: string) => ReactNode; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged, never shown raw — a stack trace is not a player-facing string.
    console.error('shell: uncaught render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error.message);
    return this.props.children;
  }
}
