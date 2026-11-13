import type { BotView, ChannelView } from "@openteam/contracts";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChannelAvatar } from "./avatar";

type ComposerSource = {
  channel: ChannelView;
  botById: ReadonlyMap<string, BotView>;
  node: HTMLDivElement;
  home: HTMLDivElement;
};
const Source = createContext<ComposerSource | null>(null);
const Register = createContext<Dispatch<SetStateAction<ComposerSource | null>>>(() => {});

export function AttachmentComposerProvider({ children }: { children: ReactNode }) {
  const [source, register] = useState<ComposerSource | null>(null);
  return (
    <Register.Provider value={register}>
      <Source.Provider value={source}>{children}</Source.Provider>
    </Register.Provider>
  );
}

/** The portal target stays stable while its DOM host moves into and out of a preview. */
export function AttachmentComposerSource({
  active,
  channel,
  botById,
  children,
}: {
  active: boolean;
  channel: ChannelView;
  botById: ReadonlyMap<string, BotView>;
  children: ReactNode;
}) {
  const register = useContext(Register);
  const home = useRef<HTMLDivElement>(null);
  const [node] = useState(() => {
    const element = document.createElement("div");
    element.dataset.composerDock = "";
    element.className = "relative z-[3] w-full shrink-0";
    return element;
  });
  useLayoutEffect(() => {
    home.current?.appendChild(node);
    return () => node.remove();
  }, [node]);
  useLayoutEffect(() => {
    if (!active || !home.current) return;
    register({ channel, botById, node, home: home.current });
    return () => register((current) => (current?.node === node ? null : current));
  }, [active, channel, botById, node, register]);
  return (
    <div
      className="relative z-[3] w-full shrink-0"
      ref={home}
      style={{ marginTop: "calc(-1 * var(--composer-overlap, 0px))" }}
    >
      {createPortal(children, node)}
    </div>
  );
}

type Flight = {
  key: number;
  text: string;
  /** Bubble origin relative to the composer at the moment of sending. */
  left: number;
  top: number;
  height: number;
  width: number;
};

const EDITOR = '[contenteditable="true"],textarea';
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One sent message: it pulls out of the composer through a goo neck, snaps free
 * (leaving a satellite droplet behind), turns the bot's colour, and arcs down into
 * the launcher.
 */
function SentFlight({
  flight,
  goo,
  fill,
  botColor,
  onLanded,
  onDone,
}: {
  flight: Flight;
  goo: HTMLElement;
  fill: string;
  botColor: string;
  onLanded: (key: number) => void;
  onDone: (key: number) => void;
}) {
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const blobRef = useRef<HTMLSpanElement>(null);
  const dropRef = useRef<HTMLSpanElement>(null);
  const callbacks = useRef({ onLanded, onDone });
  callbacks.current = { onLanded, onDone };

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const blob = blobRef.current;
    const drop = dropRef.current;
    if (!bubble || !blob || !drop) return;
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    // Centres in composer coordinates, y measured up from the composer's bottom.
    const sx = flight.left + w / 2;
    const sy = Math.max(h / 2 + 2, flight.height - flight.top - h / 2);
    const ex = flight.width / 2;
    const ey = 24;
    const dx = ex - sx;
    const apex = Math.max(sy + 84, 132);
    const rise = (share: number) => sy + (apex - sy) * share;
    // The goo layer extends 88px beyond the sides and 24px below the composer.
    const place = (x: number, y: number, inGoo = true) =>
      `translate(calc(${x + (inGoo ? 88 : 0)}px - 50%), calc(${-(y + (inGoo ? 24 : 0))}px + 50%))`;
    const smooth = "cubic-bezier(.33, 0, .25, 1)";
    const fall = "cubic-bezier(.5, 0, .85, .5)";
    type Key = [
      offset: number,
      x: number,
      y: number,
      width: number,
      height: number,
      easing?: string,
    ];
    const keys = (frames: Key[]) =>
      frames.map(([offset, x, y, width, height, easing = smooth]) => ({
        offset,
        transform: place(x, y),
        width: `${width}px`,
        height: `${height}px`,
        easing,
      }));
    const timing = { duration: 1050, fill: "both" as const };
    const animations = [
      blob.animate(
        keys([
          [0, sx, sy, w, h, "cubic-bezier(.3, 0, .2, 1)"],
          [0.1, sx, sy - 4, w * 1.05, h * 0.84],
          [0.3, sx + dx * 0.2, rise(0.72), w * 0.93, h * 1.14],
          [0.44, sx + dx * 0.48, apex, Math.max(44, w * 0.5), Math.max(34, h * 0.92)],
          [0.56, sx + dx * 0.76, apex - 16, 34, 34, fall],
          [0.82, ex, ey + 30, 24, 34],
          [1, ex, ey, 12, 12],
        ]),
        timing
      ),
      blob.animate(
        [
          { offset: 0, backgroundColor: fill },
          { offset: 0.3, backgroundColor: fill },
          { offset: 0.56, backgroundColor: botColor },
          { offset: 1, backgroundColor: botColor },
        ],
        timing
      ),
      drop.animate(
        keys([
          [0, sx, sy - 6, 16, 16],
          [0.26, sx + dx * 0.15, rise(0.44), 22, 24],
          [0.38, sx + dx * 0.24, rise(0.52), 15, 15, fall],
          [0.6, ex - dx * 0.35, 40, 12, 14],
          [0.74, ex - dx * 0.3, 26, 6, 6],
          [1, ex - dx * 0.3, 26, 0, 0],
        ]),
        timing
      ),
      bubble.animate(
        [
          { offset: 0, transform: `${place(sx, sy, false)} scale(1)`, opacity: 1 },
          { offset: 0.1, transform: `${place(sx, sy - 4, false)} scale(1.03, .86)`, opacity: 1 },
          {
            offset: 0.3,
            transform: `${place(sx + dx * 0.2, rise(0.72), false)} scale(.95, 1.08)`,
            opacity: 1,
          },
          {
            offset: 0.43,
            transform: `${place(sx + dx * 0.46, apex, false)} scale(.62)`,
            opacity: 0,
          },
          { offset: 1, transform: `${place(sx + dx * 0.46, apex, false)} scale(.6)`, opacity: 0 },
        ],
        { ...timing, easing: "cubic-bezier(.3, 0, .2, 1)" }
      ),
    ];
    const landed = window.setTimeout(() => callbacks.current.onLanded(flight.key), 880);
    const done = window.setTimeout(() => callbacks.current.onDone(flight.key), 1100);
    return () => {
      window.clearTimeout(landed);
      window.clearTimeout(done);
      for (const animation of animations) animation.cancel();
    };
  }, [flight, fill, botColor]);

  return (
    <>
      {createPortal(
        <>
          <span className="attachment-composer-goo-sent" ref={blobRef} />
          <span className="attachment-composer-goo-sent" ref={dropRef} />
        </>,
        goo
      )}
      <span aria-hidden="true" className="attachment-composer-sent" ref={bubbleRef}>
        <span>{flight.text}</span>
      </span>
    </>
  );
}

export function AttachmentComposer({
  channelId,
  dark,
}: {
  channelId: string | null;
  dark: boolean;
}) {
  const registered = useContext(Source);
  const source = registered?.channel.id === channelId ? registered : null;
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const [goo, setGoo] = useState<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // One message at a time: after a send the composer pours back into the launcher
  // and stays there while the message is in the air. Once it lands and shows
  // "Sent", hovering or clicking the launcher reopens it.
  const dismissed = useRef(false);
  const flying = useRef(false);
  const [, setDismissedVersion] = useState(0);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [delivered, setDelivered] = useState(0);
  const [fill, setFill] = useState("#3a3a3a");
  const expanded = !dismissed.current && (hovered || focused || menuOpen);
  const botColor = source?.botById.get(source.channel.members[0]?.botId ?? "")?.color ?? "#1084fe";

  const setDismissed = (value: boolean) => {
    if (dismissed.current === value) return;
    dismissed.current = value;
    setDismissedVersion((version) => version + 1);
  };
  /** Reopen into the editor; ignored while a sent message is still in the air. */
  const reopenInto = () => {
    if (flying.current) return;
    const editor = host.current?.querySelector<HTMLElement>(EDITOR);
    setDismissed(false);
    setFocused(true);
    if (!host.current || !editor) return;
    host.current.inert = false;
    editor.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!source || !host.current) return;
    const { node, home } = source;
    const height = home.style.height;
    const theme = node.getAttribute("data-theme");
    home.style.height = `${home.getBoundingClientRect().height}px`;
    if (dark) node.setAttribute("data-theme", "dark");
    host.current.appendChild(node);
    return () => {
      if (theme === null) node.removeAttribute("data-theme");
      else node.setAttribute("data-theme", theme);
      if (home.isConnected) home.appendChild(node);
      home.style.height = height;
    };
  }, [source?.node, dark]);

  useLayoutEffect(() => {
    const element = root.current;
    if (element)
      setFill(getComputedStyle(element).getPropertyValue("--goo-sent-fill").trim() || "#3a3a3a");
  }, [dark, source?.node]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    // The editor retains its original React portal, so use the actual DOM event
    // path for hover and focus as it moves between hosts.
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch" || flying.current) return;
      setDismissed(false);
      setHovered(true);
    };
    const leave = () => setHovered(false);
    // A pointer left resting on the launcher after a send reopens it once it moves
    // again after the message has landed.
    const move = (event: PointerEvent) => {
      if (!dismissed.current || flying.current || event.pointerType === "touch") return;
      if (!pill.current?.contains(event.target as Node)) return;
      setDismissed(false);
      setHovered(true);
    };
    const focus = () => {
      if (!dismissed.current) setFocused(true);
    };
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget))
        setFocused(false);
    };
    const sentMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ content?: string; attachments?: number }>).detail;
      const attachments = detail?.attachments ?? 0;
      const content = detail?.content?.trim() ?? "";
      const box = element.getBoundingClientRect();
      const text = host.current?.querySelector<HTMLElement>(EDITOR)?.getBoundingClientRect();
      setDismissed(true);
      setHovered(false);
      setFocused(false);
      // Keep keyboard focus on the launcher so Enter or Space reopens it once the
      // message has landed.
      pill.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
      if (reducedMotion()) {
        setDelivered(performance.now());
        return;
      }
      flying.current = true;
      const next: Flight = {
        key: performance.now() + Math.random(),
        text:
          content ||
          (attachments === 1
            ? "1 attachment"
            : attachments > 1
              ? `${attachments} attachments`
              : "Message"),
        // Start the bubble exactly where the draft's first line was.
        left: text ? Math.max(4, text.left - box.left - 14) : 8,
        top: text ? text.top - box.top - 8 : 4,
        height: box.height,
        width: box.width,
      };
      setFlight(next);
    };
    // A failed send restores the draft in the editor; reopen so it and the error are visible.
    const failed = () => {
      flying.current = false;
      setFlight(null);
      setDelivered(0);
      reopenInto();
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("pointermove", move);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    element.addEventListener("openteam:prompt-sent", sentMessage);
    element.addEventListener("openteam:prompt-send-failed", failed);
    const menus = new MutationObserver(() => {
      setMenuOpen(Boolean(host.current?.querySelector('[aria-expanded="true"]')));
    });
    menus.observe(element, { attributes: true, attributeFilter: ["aria-expanded"], subtree: true });
    return () => {
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      element.removeEventListener("openteam:prompt-sent", sentMessage);
      element.removeEventListener("openteam:prompt-send-failed", failed);
      menus.disconnect();
    };
  }, [source?.node]);

  useLayoutEffect(() => {
    const element = root.current;
    const surface = host.current?.querySelector<HTMLElement>("[data-prompt-surface]");
    const launcher = pill.current;
    if (!element || !surface || !launcher) return;
    // The gooey blob layer mirrors the launcher's natural width and the editor's
    // live height, so the pill pours into the surface and grows with the draft.
    const sync = () => {
      element.style.setProperty("--pill-w", `${launcher.offsetWidth}px`);
      element.style.setProperty("--surface-h", `${surface.offsetHeight}px`);
      element.style.setProperty("--surface-r", surface.offsetHeight > 48 ? "18px" : "22px");
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(surface);
    observer.observe(launcher);
    return () => observer.disconnect();
  }, [source?.node, source?.channel.name]);

  // The bot gulps each message, then the launcher returns to its usual label.
  useLayoutEffect(() => {
    if (!delivered) return;
    const body = root.current?.querySelector<HTMLElement>(".attachment-composer-goo-body");
    const gulp = reducedMotion()
      ? undefined
      : body?.animate(
          [
            { scale: "1 1" },
            { scale: "1.07 .86", offset: 0.25 },
            { scale: ".97 1.08", offset: 0.55 },
            { scale: "1.01 .98", offset: 0.8 },
            { scale: "1 1" },
          ],
          { duration: 520, easing: "ease-out" }
        );
    const reset = window.setTimeout(() => setDelivered(0), 1900);
    return () => {
      gulp?.cancel();
      window.clearTimeout(reset);
    };
  }, [delivered]);

  // Switching conversations drops anything still in the air.
  useEffect(() => {
    flying.current = false;
    setFlight(null);
    setDelivered(0);
    setDismissed(false);
  }, [channelId]);

  if (!source) return null;
  return (
    <div
      className="attachment-composer"
      data-channel-id={channelId ?? undefined}
      data-delivered={delivered ? "" : undefined}
      data-expanded={expanded || undefined}
      data-preview-composer=""
      data-sending={flight ? "" : undefined}
      data-tone={dark ? "dark" : undefined}
      ref={root}
    >
      <svg aria-hidden="true" className="attachment-composer-filter" focusable="false">
        <filter
          colorInterpolationFilters="sRGB"
          height="100%"
          id="attachment-composer-goo"
          width="100%"
          x="0"
          y="0"
        >
          <feGaussianBlur in="SourceGraphic" result="blur" stdDeviation="10" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            result="goo"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 30 -13"
          />
          <feMorphology in="goo" operator="erode" radius="1" result="inner" />
          <feComposite in="goo" in2="inner" operator="out" result="ring" />
          <feFlood className="attachment-composer-goo-edge" result="edgeColor" />
          <feComposite in="edgeColor" in2="ring" operator="in" result="edge" />
          <feMerge>
            <feMergeNode in="goo" />
            <feMergeNode in="edge" />
          </feMerge>
        </filter>
      </svg>
      <div aria-hidden="true" className="attachment-composer-goo" ref={setGoo}>
        <span className="attachment-composer-goo-drop" />
        <span className="attachment-composer-goo-drop" />
        <span className="attachment-composer-goo-body" />
      </div>
      {goo && flight && (
        <SentFlight
          botColor={botColor}
          fill={fill}
          flight={flight}
          goo={goo}
          key={flight.key}
          onDone={() => {
            flying.current = false;
            setFlight(null);
          }}
          onLanded={() => setDelivered(performance.now())}
        />
      )}
      <button
        aria-expanded={expanded}
        aria-label={`Message ${source.channel.name}`}
        className="attachment-composer-avatar"
        onClick={reopenInto}
        ref={pill}
        tabIndex={expanded ? -1 : 0}
        title={`Message ${source.channel.name}`}
        type="button"
      >
        <span className="attachment-composer-bot">
          <ChannelAvatar botById={source.botById} channel={source.channel} size="sm" />
        </span>
        <span aria-hidden="true" className="attachment-composer-label">
          <span className="attachment-composer-label-idle">
            Chat with <strong>{source.channel.name}</strong>
          </span>
          <span className="attachment-composer-label-sent">
            <span className="attachment-composer-check">
              <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                <path d="M5 12.5 10 17.5 19.5 7" pathLength="1" />
              </svg>
            </span>
            Sent to <strong>{source.channel.name}</strong>
          </span>
        </span>
      </button>
      <span className="sr-only" role="status">
        {delivered ? `Sent to ${source.channel.name}` : ""}
      </span>
      <div className="attachment-composer-editor" inert={!expanded} ref={host} />
    </div>
  );
}
