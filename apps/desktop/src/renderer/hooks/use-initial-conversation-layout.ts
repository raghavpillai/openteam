import { type RefObject, useLayoutEffect, useState } from "react";

/** Reveal once the mounted viewport has real content and stable geometry.
 * Reserved image frames do not wait on network bytes. This runs only on entry,
 * so new messages/streaming never hide an already readable conversation. */
export function useInitialConversationLayout(
  contentRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  mounted: boolean,
  contentPending = false,
  layoutKey = "",
  requiredStableFrames = 3
) {
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  const ready = completedKey === layoutKey;
  useLayoutEffect(() => setCompletedKey(null), [layoutKey]);
  useLayoutEffect(() => {
    if (!mounted) {
      setCompletedKey(null);
      return;
    }
    if (ready) return;
    // History requests own their error/timeout state. Do not reveal a bootstrap
    // preview or spend animation frames measuring while that request is pending.
    if (contentPending) return;
    const content = contentRef.current;
    const viewport = scrollRef.current;
    if (!mounted || !content || !viewport) return;
    let frame = 0;
    let previous = "";
    let stableFrames = 0;
    const visibleIn = (bounds: DOMRect) => (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= bounds.top && rect.top <= bounds.bottom;
    };
    // Mounted overscan rows also affect offsets, even if just above the screen.
    // Diagrams outside the viewport intentionally defer rendering until visible.
    const contentPendingNow = () =>
      !!content.querySelector("[data-chat-layout-pending]") ||
      [...content.querySelectorAll('[data-streamdown="mermaid-block"]')].some(
        (element) =>
          visibleIn(viewport.getBoundingClientRect())(element) &&
          !element.querySelector('[data-streamdown="mermaid"], [data-chat-diagram-error]')
      ) ||
      document.fonts.status === "loading";
    const geometry = () => {
      const bounds = viewport.getBoundingClientRect();
      const rows = [
        ...content.querySelectorAll("[data-virtual-timeline-index], [data-virtual-thread-index]"),
      ].filter(visibleIn(bounds));
      return JSON.stringify([
        viewport.scrollTop,
        viewport.scrollHeight,
        bounds.width,
        bounds.height,
        ...rows.map((row) => {
          const rect = row.getBoundingClientRect();
          return [row.getAttribute("data-virtual-timeline-key"), rect.top, rect.height];
        }),
      ]);
    };
    // Rows measured on an earlier visit mount at their cached sizes and scroll
    // position within this commit, so they can show in the first paint.
    if (requiredStableFrames === 0 && !contentPendingNow()) {
      setCompletedKey(layoutKey);
      return;
    }
    const sample = () => {
      const pending = contentPendingNow();
      const current = geometry();
      stableFrames = !pending && current === previous ? stableFrames + 1 : 0;
      previous = current;
      // Elapsed time is not evidence that a renderer has finished. Keep the
      // opening indicator until even slow content has acquired its real size.
      if (stableFrames >= Math.max(1, requiredStableFrames)) {
        setCompletedKey(layoutKey);
      } else {
        frame = requestAnimationFrame(sample);
      }
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [contentRef, scrollRef, mounted, contentPending, ready, layoutKey, requiredStableFrames]);
  return ready;
}
