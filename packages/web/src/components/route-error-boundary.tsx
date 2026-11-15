import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@/components/state-panel";
import { retryFailedRoutes } from "@/pages/lazy-pages";
import { reportCrash } from "@/lib/crash-reporting";

const CHUNK_FAILURE = /dynamically imported module|importing a module script|loading chunk|failed to fetch|load failed/i;

/** Keeps the shell on screen when a route throws or its lazy chunk cannot load, and retries when the network returns. */
export class RouteErrorBoundary extends Component<{ resetKey: string; silent?: boolean; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { if (!CHUNK_FAILURE.test(error.message)) reportCrash(error); this.syncRetryTimer(); }
  private retryTimer: number | undefined;
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.reset();
    this.syncRetryTimer();
  }
  componentDidMount() { window.addEventListener("online", this.reset); }
  componentWillUnmount() { window.removeEventListener("online", this.reset); window.clearInterval(this.retryTimer); }
  /** A failed chunk import also happens while the server is down (the browser can still be "online"), so keep retrying until it loads. */
  private syncRetryTimer() {
    const retrying = Boolean(this.state.error && CHUNK_FAILURE.test(this.state.error.message));
    if (retrying && this.retryTimer === undefined) this.retryTimer = window.setInterval(this.reset, 5000);
    else if (!retrying && this.retryTimer !== undefined) { window.clearInterval(this.retryTimer); this.retryTimer = undefined; }
  }
  reset = () => { if (this.state.error) { retryFailedRoutes(); this.setState({ error: null }); } };
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;
    const shown = CHUNK_FAILURE.test(error.message) ? new Error("Couldn't load this page. It will retry when the connection returns.") : error;
    return <div data-testid="route-error" className="p-6"><ErrorState error={shown} onRetry={this.reset} /></div>;
  }
}
