import { createContext, useContext } from "react";

/** Keeps chat history in the persistent app sidebar while chat state owns its UI. */
export const SidebarHistoryContext = createContext<HTMLDivElement | null>(null);
export const useSidebarHistory = () => useContext(SidebarHistoryContext);
