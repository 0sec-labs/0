import { createContext, useContext } from "react";
import type { BackendDescriptor } from "@0/shared/dist/backend-protocol.js";
import type { BackendApi } from "./api";

export const BackendApiContext = createContext<BackendApi | null>(null);
export function useBackendApi(): BackendApi {
  const api = useContext(BackendApiContext);
  if (!api) throw new Error("Engine controls require a backend-bound client.");
  return api;
}

export interface BackendSelection {
  backends: BackendDescriptor[];
  backendId: string;
  status: string;
  select: (backendId: string) => void;
  reconnect: () => void;
}
export const BackendSelectionContext = createContext<BackendSelection | null>(null);
export function useBackendSelection() { return useContext(BackendSelectionContext); }
