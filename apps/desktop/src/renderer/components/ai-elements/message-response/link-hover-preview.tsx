import { ArrowUpRight, Globe } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const WIDTH = 300;
const GAP = 8;
const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 120;

/** The address shown on hover: host, then path and query (no protocol or fragment). */
export function linkPreviewParts(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    return { host: url.host, rest };
  } catch {
    return null;
  }
}

/**
 * Shows the full address in a small card above a hovered link, centered on it.
 * Hovering the card keeps it open; clicking it opens the link like the link itself.
 */
export function useLinkHoverPreview(href: string | undefined) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const schedule = (next: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const parts = href ? linkPreviewParts(href) : null;
  const handlers = parts
    ? {
        onMouseEnter: () => schedule(true, OPEN_DELAY_MS),
        onMouseLeave: () => schedule(false, CLOSE_DELAY_MS),
        onFocus: () => schedule(true, 0),
        onBlur: () => schedule(false, 0),
      }
    : {};
  const preview =
    open && parts && href ? (
      <LinkHoverPreview
        anchor={anchor}
        href={href}
        host={parts.host}
        rest={parts.rest}
        onEnter={() => window.clearTimeout(timer.current)}
        onLeave={() => schedule(false, CLOSE_DELAY_MS)}
      />
    ) : null;
  return { anchor, handlers, preview };
}

function LinkHoverPreview({
  anchor,
  href,
  host,
  rest,
  onEnter,
  onLeave,
}: {
  anchor: RefObject<HTMLAnchorElement | null>;
  href: string;
  host: string;
  rest: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const link = anchor.current;
    if (!link) return;
    // A wrapped link centers on its first line, where the pointer usually is.
    const line = link.getClientRects()[0] ?? link.getBoundingClientRect();
    const height = card.current?.offsetHeight ?? 36;
    const width = Math.min(WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, line.left + line.width / 2 - width / 2));
    const above = line.top - GAP - height;
    setPosition({ left, top: above >= 8 ? above : line.bottom + GAP });
  }, [anchor]);
  return createPortal(
    <div
      className="link-hover-preview"
      data-visible={position ? "" : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      ref={card}
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999, width: Math.min(WIDTH, window.innerWidth - 16) }}
    >
      <a href={href} rel="noopener noreferrer" target="_blank" tabIndex={-1}>
        <Globe aria-hidden="true" className="link-hover-preview-globe" strokeWidth={1.75} />
        <span className="link-hover-preview-address">
          <span className="link-hover-preview-host">{host}</span>
          <span className="link-hover-preview-path">{rest}</span>
        </span>
        <ArrowUpRight aria-hidden="true" className="link-hover-preview-arrow" strokeWidth={1.75} />
      </a>
    </div>,
    document.body
  );
}
