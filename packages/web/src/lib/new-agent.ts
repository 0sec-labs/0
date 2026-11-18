import { useSyncExternalStore } from "react";

/** One "New sentinel" dialog for the whole app: every entry point (sidebar, page, home chip, palette) opens it through here. */
let isOpen = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => { if (isOpen === next) return; isOpen = next; listeners.forEach(listener => listener()); };

export const openNewAgent = (): void => set(true);
export const isNewAgentOpen = (): boolean => isOpen;
export const setNewAgentOpen = (open: boolean): void => set(open);
export function useNewAgentOpen(): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => isOpen, () => false);
}
