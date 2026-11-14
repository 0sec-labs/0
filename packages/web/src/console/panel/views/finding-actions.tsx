import { createContext, useContext, type ReactNode } from "react";
import type { FindingRecord } from "../../../types";
import type { FixPrLink } from "./findings-model";

/** Host-provided capabilities for findings views. WP6 mounts this around the panel. */
export type FindingActions = {
  /** Append the finding context to the composer draft (`addFindingToDraft`). Omit to hide the action. */
  onAddFinding?: (finding: FindingRecord) => void;
  /** Known fix proposals for this chat; only `published.prUrl` and `finding.id` are read. */
  fixes?: readonly FixPrLink[];
};
const FindingActionsContext = createContext<FindingActions>({});
export function FindingActionsProvider({ value, children }: { value: FindingActions; children: ReactNode }) {
  return <FindingActionsContext.Provider value={value}>{children}</FindingActionsContext.Provider>;
}
export const useFindingActions = () => useContext(FindingActionsContext);
