import { QueryClient } from "@tanstack/react-query";

type Options = { gcTime?: number; staleTime?: number; refetchOnWindowFocus?: boolean };

/** The one QueryClient factory. Scoped clients (per engine/backend) pass overrides; everything else shares these defaults. */
export function makeQueryClient(options: Options = {}): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { ...options } } });
}

/** Per-engine scope: lists stay fresh for 15 s and refetch when the window regains focus. */
export const SCOPED_QUERY_DEFAULTS: Options = { staleTime: 15_000, refetchOnWindowFocus: true };
