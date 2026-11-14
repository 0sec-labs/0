import { useEffect, useRef } from "react";
import { COMPOSER_PREFILL_EVENT, consumeComposerPrefill, mergePrefill } from "@/lib/composer-prefill";

/**
 * Applies text queued with `queueComposerPrefill` to the composer this workspace owns, on mount and whenever one is
 * queued. Waits until `ready` (the mission id is known, so the draft lands under the key the composer reads).
 */
export function useComposerPrefill(ready: boolean, readDraft: () => string, setDraft: (value: string) => void) {
  const latest = useRef({ readDraft, setDraft });
  latest.current = { readDraft, setDraft };
  useEffect(() => {
    if (!ready) return;
    const apply = () => {
      const text = consumeComposerPrefill();
      if (!text) return;
      latest.current.setDraft(mergePrefill(latest.current.readDraft(), text));
      // After the draft renders, put the caret at the end of the composer.
      window.setTimeout(() => {
        const field = document.querySelector<HTMLTextAreaElement>("[data-composer-textarea]:not(:disabled)");
        if (!field) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
      }, 60);
    };
    apply();
    window.addEventListener(COMPOSER_PREFILL_EVENT, apply);
    return () => window.removeEventListener(COMPOSER_PREFILL_EVENT, apply);
  }, [ready]);
}
