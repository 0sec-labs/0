import { createContext, useContext } from "react";
import type { BackendApi } from "./api";

export const BackendApiContext = createContext<BackendApi | null>(null);
export function useBackendApi(): BackendApi {
  const api = useContext(BackendApiContext);
  if (!api) throw new Error("Engine controls require a backend-bound client.");
  return api;
}
