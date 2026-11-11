import { Eye, LoaderCircle, SquareMousePointer } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import "./computer-control-bar.css";

// The voice composer's 0.42 s / 0.86 damping spring, sampled for CSS/WAAPI.
const spring = (() => {
  const omega = (2 * Math.PI) / 0.42,
    damping = 0.86;
  const frequency = omega * Math.sqrt(1 - damping * damping);
  return `linear(${Array.from({ length: 73 }, (_, i) => {
    const t = i / 120;
    const value =
      1 -
      Math.exp(-damping * omega * t) *
        (Math.cos(frequency * t) + ((damping * omega) / frequency) * Math.sin(frequency * t));
    return `${i === 72 ? 1 : value.toFixed(5)} ${((i / 72) * 100).toFixed(3)}%`;
  }).join(",")})`;
})();

function Caption({ text }: { text: string }) {
  const last = useRef(text);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (last.current === text) return;
    setOutgoing(last.current);
    last.current = text;
    const timer = window.setTimeout(() => setOutgoing(null), 220);
    return () => window.clearTimeout(timer);
  }, [text]);
  return (
    <span className="computer-control-caption">
      {outgoing && (
        <span aria-hidden="true" className="computer-control-caption-out" key={`old:${outgoing}`}>
          {outgoing}
        </span>
      )}
      <span className={outgoing ? "computer-control-caption-in" : undefined} key={text}>
        {text}
      </span>
    </span>
  );
}

export function ComputerControlBar({
  label,
  controlling,
  pending,
  available,
  anotherDevice,
  hint,
  onChange,
  onResume,
}: {
  label: string;
  controlling: boolean;
  pending: boolean;
  available: boolean;
  anotherDevice: boolean;
  hint: boolean;
  onChange: () => void;
  onResume: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const skin = useRef<HTMLDivElement>(null);
  const lastOwned = useRef(controlling);
  useLayoutEffect(() => {
    if (lastOwned.current === controlling) return;
    lastOwned.current = controlling;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = skin.current!.animate(
      [
        { scale: "1 1", offset: 0 },
        { scale: "1.025 .94", offset: 0.25 },
        { scale: ".995 1.018", offset: 0.58 },
        { scale: "1 1", offset: 1 },
      ],
      { duration: 600, easing: spring }
    );
    return () => animation.cancel();
  }, [controlling]);
  const [showPending, setShowPending] = useState(false);
  useLayoutEffect(() => {
    if (!pending) {
      setShowPending(false);
      return;
    }
    const timer = window.setTimeout(() => setShowPending(true), 150);
    return () => window.clearTimeout(timer);
  }, [pending]);
  useLayoutEffect(() => {
    const element = root.current!,
      inside = content.current!;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let motion: Animation | undefined;
    let width = 0;
    const positions = new Map<HTMLElement, number>();
    const movements = new Map<HTMLElement, Animation>();
    let actionWidth = 0;
    let actionMotion: Animation | undefined;
    const resize = () => {
      const target = Math.min(
        inside.getBoundingClientRect().width,
        element.parentElement!.clientWidth - 32
      );
      if (!target || target === width) return;
      // Move content on the same spring as the rim, without scaling its glyphs.
      for (const node of inside.querySelectorAll<HTMLElement>(
        ":scope > .computer-control-status, :scope > button"
      )) {
        // Anchor buttons at their center as their intrinsic width changes.
        const left = node.offsetLeft + (node.tagName === "BUTTON" ? node.offsetWidth / 2 : 0);
        const previous = positions.get(node);
        const transform = getComputedStyle(node).transform;
        const translated = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
        movements.get(node)?.cancel();
        if (
          previous !== undefined &&
          !preference.matches &&
          (previous !== left || target !== width)
        ) {
          movements.set(
            node,
            node.animate(
              [
                {
                  transform: `translateX(${previous + translated + (target - width) / 2 - left}px)`,
                },
                { transform: "translateX(0)" },
              ],
              { duration: 600, easing: spring }
            )
          );
        }
        positions.set(node, left);
      }
      const action = inside.querySelector<HTMLElement>(".computer-control-action")!;
      const backplate = action.querySelector<HTMLElement>(".computer-control-action-skin")!;
      const nextActionWidth = action.offsetWidth;
      const matrix = getComputedStyle(backplate).transform;
      const currentScale = matrix === "none" ? 1 : new DOMMatrixReadOnly(matrix).m11;
      actionMotion?.cancel();
      if (actionWidth && !preference.matches) {
        actionMotion = backplate.animate(
          [
            { transform: `scaleX(${(actionWidth * currentScale) / nextActionWidth})` },
            { transform: "scaleX(1)" },
          ],
          { duration: 600, easing: spring }
        );
      }
      actionWidth = nextActionWidth;
      const from = skin.current!.getBoundingClientRect().width;
      motion?.cancel();
      element.style.width = `${target}px`;
      if (width && !preference.matches) {
        motion = skin.current!.animate(
          [{ transform: `scaleX(${from / target})` }, { transform: "scaleX(1)" }],
          {
            duration: 600,
            easing: spring,
          }
        );
      }
      width = target;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(inside);
    const changed = () => {
      motion?.cancel();
      actionMotion?.cancel();
      for (const movement of movements.values()) movement.cancel();
      resize();
    };
    preference.addEventListener("change", changed);
    resize();
    return () => {
      for (const movement of movements.values()) movement.cancel();
      observer.disconnect();
      motion?.cancel();
      actionMotion?.cancel();
      preference.removeEventListener("change", changed);
    };
  }, []);
  const action = controlling ? "Stop" : anotherDevice ? "Take control here" : "Take control";
  return (
    <div
      ref={root}
      role="group"
      aria-label="Computer control"
      className="computer-control-bar"
      data-owned={controlling}
      style={{ "--control-spring": spring } as CSSProperties}
    >
      <div ref={skin} className="computer-control-skin" aria-hidden="true" />
      <div className="computer-control-content" ref={content}>
        <span className="computer-control-status" role="status" aria-live="polite">
          <span className="computer-control-symbol" aria-hidden="true">
            <Eye data-shown={!controlling && !showPending} />
            <SquareMousePointer data-shown={controlling && !showPending} />
            <LoaderCircle className="computer-control-spinner" data-shown={showPending} />
          </span>
          <Caption text={showPending ? "Changing control…" : label} />
        </span>
        {hint && !controlling && !anotherDevice && (
          <span className="computer-control-hint">Take control to click and type</span>
        )}
        <button
          type="button"
          className="computer-control-action"
          aria-label={controlling ? "Give back control" : action}
          disabled={pending || (!controlling && !available)}
          onClick={onChange}
        >
          <span className="computer-control-action-skin" aria-hidden="true" />
          <Caption text={action} />
        </button>
        {anotherDevice && (
          <button
            type="button"
            className="computer-control-resume"
            disabled={pending}
            onClick={onResume}
          >
            Resume bot
          </button>
        )}
      </div>
    </div>
  );
}
