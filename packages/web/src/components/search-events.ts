export type SearchMode = "all" | "chats";
export type SearchRequest = { mode: SearchMode; returnFocus?: HTMLElement };
/** Lives apart from the palette so opening search never pulls the palette (and cmdk) into the entry chunk. */
export function openAppSearch(mode: SearchMode = "all", returnFocus?: HTMLElement) {
  holdKeystrokes();
  window.dispatchEvent(new CustomEvent<SearchRequest>("zero:open-search", { detail: { mode, returnFocus } }));
}

let held = "";
let release: (() => void) | null = null;
/** Keys typed while the palette is still loading are held, then handed to its input, so no character is lost. */
function holdKeystrokes() {
  release?.();
  held = "";
  const onKey = (event: KeyboardEvent) => {
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    held += event.key;
  };
  const timer = window.setTimeout(() => release?.(), 3000);
  window.addEventListener("keydown", onKey, true);
  release = () => { window.removeEventListener("keydown", onKey, true); window.clearTimeout(timer); release = null; };
}
export function takeHeldSearchText(): string {
  const text = held;
  held = "";
  release?.();
  return text;
}
