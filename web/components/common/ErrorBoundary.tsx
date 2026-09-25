import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './ErrorState';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback; receives the error and a reset function. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Changing this value resets the boundary (e.g. the current pathname). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

/** Catches render errors below it and shows an error state with a retry. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Surfaced in the browser console for bug reports; there is no client-side log sink.
    // eslint-disable-next-line no-console
    console.error('Render error', error, info.componentStack);
  }

  private readonly reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="p-4 sm:p-6">
        <ErrorState title="Something went wrong on this page" error={error} onRetry={this.reset} />
      </div>
    );
  }
}
