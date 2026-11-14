export type SearchMode = "all" | "chats";
export type SearchRequest = { mode: SearchMode; returnFocus?: HTMLElement };
/** Lives apart from the palette so opening search never pulls the palette (and cmdk) into the entry chunk. */
export function openAppSearch(mode: SearchMode = "all", returnFocus?: HTMLElement) {
  window.dispatchEvent(new CustomEvent<SearchRequest>("zero:open-search", { detail: { mode, returnFocus } }));
}
