/** @jsxImportSource @opentui/react */
import React, { useEffect, useRef } from "react";
import { getWorkspaceHarnessTrust, type LiveHarnessHost } from "@0/core";
import { logProblem } from "./tui-crash.js";

/** Applies pending host changes only after an active turn reaches its checkpoint. */
export function HarnessLifecycle({ children, host, busy, workspaceRoot }: {
  children: React.ReactNode;
  host: LiveHarnessHost | null;
  busy: boolean;
  workspaceRoot: string;
}) {
  const previousBusy = useRef(busy);
  useEffect(() => {
    const becameIdle = previousBusy.current && !busy;
    previousBusy.current = busy;
    if (!becameIdle || !host) return;
    const snapshot = host.snapshot();
    if (snapshot.status === "pending" || (snapshot.trusted && !getWorkspaceHarnessTrust(workspaceRoot))) {
      void host.checkpoint().catch((error: unknown) => logProblem("harness-checkpoint", error));
    }
  }, [busy, host, workspaceRoot]);

  return <>{children}</>;
}
