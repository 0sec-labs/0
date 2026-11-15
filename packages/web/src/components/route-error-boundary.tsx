import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@/components/state-panel";
import { retryFailedRoutes } from "@/pages/lazy-pages";
import { reportCrash } from "@/lib/crash-reporting";
import { CHUNK_FAILURE, currentBuildId, reloadOnceForBuild } from "@/lib/chunk-reload";

/** Reload the page once per build when the server is up but the old build's chunks are gone. */
function reloadIfServerIsUp() {
  void fetch(window.location.pathname, { cache: "no-store", method: "HEAD" }).then(response => {
    if (response.ok) reloadOnceForBuild(currentBuildId(), window.sessionStorage, () => window.location.reload());
  }).catch(() => undefined);
}


/** Keeps the shell on screen when a route throws or its lazy chunk cannot load, and retries when the network returns. */
export class RouteErrorBoundary extends Component<{ resetKey: string; silent?: boolean; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    if (!CHUNK_FAILURE.test(error.message)) { reportCrash(error); this.syncRetryTimer(); return; }
    // First failure: one quick automatic retry. Second: the tab is on a stale build, so reload the page once.
    this.chunkFailures += 1;
    if (this.chunkFailures === 1) window.setTimeout(this.reset, 400); else reloadIfServerIsUp();
    this.syncRetryTimer();
  }
  private chunkFailures = 0;
  private retryTimer: number | undefined;
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) { this.chunkFailures = 0; this.reset(); }
    this.syncRetryTimer();
  }
  componentDidMount() { window.addEventListener("online", this.reset); window.addEventListener("vite:preloadError", this.onPreloadError); }
  /**
   * Vite fires this when a lazy chunk's preload fails; a reload of the new build is the fix, and it is guarded to once.
   * Only when the server answers: while it restarts (an update) a reload would land on the browser's error page and use up the guard.
   */
  private onPreloadError = (event: Event) => { event.preventDefault(); reloadIfServerIsUp(); };
  componentWillUnmount() { window.removeEventListener("online", this.reset); window.removeEventListener("vite:preloadError", this.onPreloadError); window.clearInterval(this.retryTimer); }
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
