import { lazy, Suspense } from "react";
import { OperationsApp } from "@/pages/operations-app";
import { mockUxEnabled } from "@/mock-ux/flag";

// PROTOTYPE: dev builds only, opted in with ?mock=ux. See src/mock-ux.
const MockUxApp = import.meta.env.DEV ? lazy(() => import("@/mock-ux/mock-app").then(module => ({ default: module.MockUxApp }))) : null;

export function App() {
  if (MockUxApp && mockUxEnabled()) return <Suspense fallback={null}><MockUxApp /></Suspense>;
  return (
    <OperationsApp />
  );
}
