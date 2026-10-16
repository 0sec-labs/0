import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import "./activity-row.css";

/** A single keyboard-accessible disclosure; collapsed contents cannot receive focus. */
export function ActivityRow({ icon, title, status, running = false, failed = false, children }: {
  icon: ReactNode;
  title: string;
  status: string;
  running?: boolean;
  failed?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <section className="console-tool-row" data-running={running || undefined} data-expanded={expanded || undefined}>
    <button type="button" id={`${id}-trigger`} className="console-tool-trigger" aria-expanded={expanded}
      aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}>
      <span aria-hidden="true" className="console-tool-icon">{icon}</span>
      <span className="console-tool-title">{title}</span>
      {status && <span className={`console-tool-status${failed ? " console-tool-status-error" : ""}`} role="status" aria-live="polite" aria-atomic="true">{status}</span>}
      <ChevronDown aria-hidden="true" className="console-tool-chevron" />
    </button>
    <div id={`${id}-details`} className="console-tool-reveal" aria-labelledby={`${id}-trigger`}
      aria-hidden={!expanded} inert={!expanded}>
      <div className="console-tool-reveal-inner"><div className="console-tool-details">{children}</div></div>
    </div>
  </section>;
}
