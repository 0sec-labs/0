import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Generic on purpose: the error message is never put in the page. */
export function CrashFallback({ onReload }: { onReload: () => void }) {
  return <div role="alert" data-testid="app-crash" className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
    <h1 className="text-lg font-medium">Something went wrong</h1>
    <p className="max-w-md text-sm text-muted-foreground">0security hit an unexpected error in this page. Reload to continue. Your chats and settings are safe.</p>
    <Button onClick={onReload}>Reload</Button>
  </div>;
}

/** App-root boundary: reports the closed category once, then shows the generic fallback. */
export class AppErrorBoundary extends Component<{ onError: (error: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { try { this.props.onError(error); } catch { /* reporting must never break the fallback */ } }
  render() {
    return this.state.failed ? <CrashFallback onReload={() => window.location.reload()} /> : this.props.children;
  }
}
