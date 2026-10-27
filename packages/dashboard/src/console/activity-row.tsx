import { ActivityIcon } from "@/components/ui/activity-chip";
import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import "./activity-row.css";
import { Disclosure } from "@/components/ui/disclosure";

/** A single keyboard-accessible disclosure; collapsed contents cannot receive focus. */
export function ActivityRow({ icon, title, status, running = false, failed = false, children }: {
  icon: ReactNode;
  title: string;
  status: string;
  running?: boolean;
  failed?: boolean;
  children: ReactNode;
}) {
  return <Disclosure className="console-tool-row" data-running={running || undefined} triggerClassName="console-tool-trigger" contentClassName="console-tool-details" summary={<>
    <ActivityIcon className="console-tool-icon">{icon}</ActivityIcon>
    <span className="console-tool-title">{title}</span>
    {status && <span className={`console-tool-status${failed ? " console-tool-status-error" : ""}`} role="status" aria-live="polite" aria-atomic="true">{status}</span>}
    <ChevronDown aria-hidden="true" className="console-tool-chevron ui-disclosure-chevron" />
  </>}>{children}</Disclosure>;
}
