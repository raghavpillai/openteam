import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./plugin-pages.css";

/** Retain the outgoing pane (and its scroll position) until the wipe finishes. */
export function PluginPageStack({
  pageKey,
  direction,
  children,
}: {
  pageKey: string;
  direction: "push" | "pop";
  children: ReactNode;
}) {
  const current = useRef<HTMLDivElement>(null);
  const previous = useRef({ key: pageKey, children });
  const focusTargets = useRef(new Map<string, { label: string | null; text: string | null }>());
  const scrollPositions = useRef(new Map<string, number[]>());
  const [transition, setTransition] = useState<{
    key: string;
    from: { key: string; children: ReactNode } | null;
    direction: "push" | "pop";
  }>({ key: pageKey, from: null, direction });

  if (transition.key !== pageKey) {
    const from = previous.current;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && current.current?.contains(focused))
      focusTargets.current.set(from.key, {
        label: focused.getAttribute("aria-label"),
        text: focused.matches("button") ? focused.textContent : null,
      });
    scrollPositions.current.set(
      from.key,
      Array.from(current.current?.querySelectorAll<HTMLElement>(".bot-scrollbar") ?? []).map(
        (node) => node.scrollTop
      )
    );
    setTransition({
      key: pageKey,
      from: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? null : from,
      direction,
    });
  }
  useLayoutEffect(() => {
    previous.current = { key: pageKey, children };
  });
  useLayoutEffect(() => {
    const pane = current.current;
    if (!pane) return;
    const offsets = scrollPositions.current.get(pageKey);
    pane.querySelectorAll<HTMLElement>(".bot-scrollbar").forEach((node, index) => {
      node.scrollTop = offsets?.[index] ?? 0;
    });
    const landing = direction === "pop" ? focusTargets.current.get(pageKey) : null;
    const target = landing
      ? Array.from(pane.querySelectorAll<HTMLElement>("button, input, [aria-label]")).find(
          (node) =>
            landing.label
              ? node.getAttribute("aria-label") === landing.label
              : landing.text && node.textContent === landing.text
        )
      : null;
    const focusHeading = () => {
      const heading = pane.querySelector<HTMLElement>("h1, h2, h3, [data-plugin-heading]");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        return true;
      }
      return false;
    };
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
    if (focusHeading()) return;
    pane.focus({ preventScroll: true });
    // Lazy pages can arrive after the navigation commit. Move focus once their heading exists.
    const observer = new MutationObserver(() => {
      if (
        document.activeElement !== pane &&
        document.activeElement !== pane.closest("[role=dialog]") &&
        document.activeElement !== document.body
      ) {
        observer.disconnect();
        return;
      }
      if (focusHeading()) observer.disconnect();
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pageKey, direction]);
  useEffect(() => {
    if (!transition.from) return;
    const timer = window.setTimeout(
      () =>
        setTransition((value) => (value.key === transition.key ? { ...value, from: null } : value)),
      250
    );
    return () => window.clearTimeout(timer);
  }, [transition]);

  return (
    <div className="plugin-page-viewport">
      {transition.from && (
        <div
          key={transition.from.key}
          className="plugin-page plugin-page-outgoing"
          data-direction={transition.direction}
          aria-hidden="true"
          inert
        >
          {transition.from.children}
        </div>
      )}
      <div
        key={pageKey}
        ref={current}
        className="plugin-page"
        data-direction={transition.from ? transition.direction : undefined}
        tabIndex={-1}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget)
            setTransition((value) => ({ ...value, from: null }));
        }}
      >
        {children}
      </div>
    </div>
  );
}
