import { useEffect, useState } from "react";

/** Only a chat that is actually on screen polls at the running-turn rate; hidden dock tabs back off. */
export function useChatVisibility() {
  const [chatElement, setChatElement] = useState<HTMLElement | null>(null);
  const [chatVisible, setChatVisible] = useState(true);
  useEffect(() => {
    if (!chatElement || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) setChatVisible(last.isIntersecting);
    });
    observer.observe(chatElement);
    return () => observer.disconnect();
  }, [chatElement]);
  return { setChatElement, chatVisible };
}
