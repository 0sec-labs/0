import { createContext, useContext, type ReactNode } from "react";
import type { FindingRecord } from "../../../types";

/** Host-provided capabilities for findings views. WP6 mounts this around the panel. */
export type FindingActions = {
  /** Append the finding context to the composer draft (`addFindingToDraft`). Omit to hide the action. */
  onAddFinding?: (finding: FindingRecord) => void;
};
const FindingActionsContext = createContext<FindingActions>({});
export function FindingActionsProvider({ value, children }: { value: FindingActions; children: ReactNode }) {
  return <FindingActionsContext.Provider value={value}>{children}</FindingActionsContext.Provider>;
}
export const useFindingActions = () => useContext(FindingActionsContext);
