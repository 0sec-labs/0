import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@/components/state-panel";
import { retryFailedRoutes } from "@/pages/lazy-pages";

const CHUNK_FAILURE = /dynamically imported module|importing a module script|loading chunk|failed to fetch|load failed/i;

/** Keeps the shell on screen when a route throws or its lazy chunk cannot load, and retries when the network returns. */
export class RouteErrorBoundary extends Component<{ resetKey: string; silent?: boolean; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* rendered below; nothing to report */ }
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.reset();
  }
  componentDidMount() { window.addEventListener("online", this.reset); }
  componentWillUnmount() { window.removeEventListener("online", this.reset); }
  reset = () => { if (this.state.error) { retryFailedRoutes(); this.setState({ error: null }); } };
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;
    const shown = CHUNK_FAILURE.test(error.message) ? new Error("Couldn't load this page. It will retry when the connection returns.") : error;
    return <div data-testid="route-error" className="p-6"><ErrorState error={shown} onRetry={this.reset} /></div>;
  }
}
