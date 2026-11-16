import { createContext, useContext, type ReactNode } from "react";
import { SourceContext } from "../../source-context";
import { ToolCatalog } from "../../tool-catalog";
import type { PanelViewComponent } from "../types";

/** Host-provided panel capabilities. Omitted callbacks leave the controls inert. */
export type PanelActions = {
  /** Append text to the composer draft without replacing it (visual references). */
  appendPrompt?: (text: string) => void;
};
export const PanelActionsContext = createContext<PanelActions>({});
export function PanelActionsProvider({ value, children }: { value: PanelActions; children: ReactNode }) {
  return <PanelActionsContext.Provider value={value}>{children}</PanelActionsContext.Provider>;
}

/** Source context and the available-tool catalog. */
export const ToolsView: PanelViewComponent = ({ snapshot }) => {
  if (!snapshot)
    return (
      <p role="status" className="p-4 text-center text-xs text-muted-foreground-2">
        Loading chat…
      </p>
    );
  return (
    <div className="min-w-0 space-y-3 p-3 text-sm">
      <SourceContext context={snapshot.sourceContext} />
      <ToolCatalog tools={snapshot.tools} />
    </div>
  );
};
