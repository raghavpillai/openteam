import { forwardRef, memo, useEffect, useId, useImperativeHandle, useRef } from "react";
import { clamp } from "./motion";

export interface MascotHandle {
  root: HTMLDivElement | null;
  /** Look toward a point in overlay coordinates, or straight ahead with null. Scenes pass the
   * robot's face position they already know, so no layout is read back mid-frame. */
  look(point: { x: number; y: number } | null, origin?: { x: number; y: number }): void;
  blink(): void;
  /** A quick antenna boing, for keystrokes and landings. */
  boing(strength?: number): void;
  setHappy(happy: boolean): void;
}

/**
 * OpenTeam's robot, drawn from the app icon's own layers (body, visor, eyes, mouth).
 *
 * Idle costs nothing per frame: nothing loops. The gaze is a CSS transition set only when the
 * target changes, blinks are a timer toggling a class, and a frame loop runs only while the
 * antenna is springing after a boing, then stops itself.
 */
export const Mascot = memo(forwardRef<MascotHandle, { size: number; className?: string }>(function Mascot(
  { size, className },
  forwarded
) {
  const id = useId().replace(/:/g, "");
  const root = useRef<HTMLDivElement>(null);
  const antenna = useRef<SVGGElement>(null);
  const visor = useRef<SVGGElement>(null);
  const eyes = useRef<SVGGElement>(null);
  const eyeShapes = useRef<SVGGElement>(null);
  const happyEyes = useRef<SVGGElement>(null);
  const motion = useRef({ angle: 0, velocity: 0, frame: 0, last: 0, gaze: "" });

  const spin = () => {
    const state = motion.current;
    if (state.frame) return;
    state.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - state.last) / 1_000);
      state.last = now;
      state.velocity += (-120 * state.angle - 9 * state.velocity) * dt;
      state.angle += state.velocity * dt;
      antenna.current?.setAttribute("transform", `rotate(${state.angle.toFixed(2)} 50 24)`);
      if (Math.abs(state.angle) < 0.05 && Math.abs(state.velocity) < 0.5) {
        state.angle = 0;
        state.velocity = 0;
        state.frame = 0;
        antenna.current?.setAttribute("transform", "");
        return;
      }
      state.frame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(tick);
  };

  useImperativeHandle(forwarded, () => ({
    get root() { return root.current; },
    look(point, origin) {
      const element = root.current;
      let x = 0;
      let y = 0;
      if (point && element) {
        let face = origin;
        if (!face) {
          const box = element.getBoundingClientRect();
          face = { x: box.left + box.width / 2, y: box.top + box.height * 0.45 };
        }
        const dx = point.x - face.x;
        const dy = point.y - face.y;
        const distance = Math.hypot(dx, dy) || 1;
        const reach = clamp(distance / 160, 0, 1);
        x = (dx / distance) * 4.2 * reach;
        y = (dy / distance) * 2.8 * reach;
      }
      // Quantized to half a unit, so small pointer moves don't restyle anything.
      x = Math.round(x * 2) / 2;
      y = Math.round(y * 2) / 2;
      const gaze = `${x},${y}`;
      if (gaze === motion.current.gaze) return;
      motion.current.gaze = gaze;
      eyes.current?.style.setProperty("transform", `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`);
      visor.current?.style.setProperty("transform", `translate(${(x * 0.3).toFixed(2)}px, ${(y * 0.25).toFixed(2)}px)`);
    },
    blink() {
      const shapes = eyeShapes.current;
      if (!shapes) return;
      shapes.classList.add("is-blinking");
      window.setTimeout(() => shapes.classList.remove("is-blinking"), 140);
    },
    boing(strength = 1) {
      motion.current.velocity += (Math.random() > 0.5 ? 1 : -1) * 260 * strength;
      spin();
    },
    setHappy(happy) {
      root.current?.toggleAttribute("data-happy", happy);
    },
  }), []);

  useEffect(() => {
    // Blinks on a timer, with an occasional double blink; nothing runs between them.
    let timer = 0;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        const shapes = eyeShapes.current;
        // Hidden, nothing to blink for: check again much later instead of every few seconds.
        if (document.hidden) {
          schedule(30_000);
          return;
        }
        if (shapes) {
          shapes.classList.add("is-blinking");
          window.setTimeout(() => shapes.classList.remove("is-blinking"), 140);
        }
        schedule(Math.random() < 0.18 ? 280 : 2_200 + Math.random() * 3_200);
      }, delay);
    };
    schedule(1_400 + Math.random() * 2_000);
    const state = motion.current;
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, []);

  return (
    <div ref={root} className={`appshot-mascot ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <div className="appshot-mascot-body">
        <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible">
          <defs>
            <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--mascot-body-top)" />
              <stop offset="1" stopColor="var(--mascot-body-bottom)" />
            </linearGradient>
            <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#272c2e" />
              <stop offset="1" stopColor="#101719" />
            </linearGradient>
            <linearGradient id={`${id}-eye`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#7ef0e0" />
              <stop offset="1" stopColor="#3ac6b7" />
            </linearGradient>
            <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.42" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g ref={antenna}>
            <rect x="47" y="6" width="6" height="18" rx="3" fill={`url(#${id}-body)`} />
            <circle cx="50" cy="7" r="5.5" fill={`url(#${id}-body)`} />
            <circle cx="48.4" cy="5.2" r="1.6" fill="#fff" opacity="0.55" />
          </g>
          <rect x="14" y="22" width="72" height="62" rx="14" fill={`url(#${id}-body)`} />
          <rect x="14" y="22" width="72" height="62" rx="14" fill={`url(#${id}-shine)`} />
          <rect x="14.5" y="22.5" width="71" height="61" rx="13.5" fill="none" stroke="#fff" strokeOpacity="0.28" />
          <g ref={visor} className="appshot-mascot-visor">
            <g transform="translate(52 0) scale(0.9703 1) translate(-50 0)">
              <rect x="24" y="36" width="52" height="20" rx="10" fill={`url(#${id}-face)`} />
              <g ref={eyes} className="appshot-mascot-gaze">
                <g ref={eyeShapes} className="appshot-mascot-eyes">
                  <circle cx="40.5" cy="46" r="4" fill={`url(#${id}-eye)`} />
                  <circle cx="64.5" cy="46" r="4" fill={`url(#${id}-eye)`} />
                </g>
                <g ref={happyEyes} className="appshot-mascot-happy" fill="none" stroke={`url(#${id}-eye)`} strokeWidth="2.8" strokeLinecap="round">
                  <path d="M36.2 47.6 Q40.5 42 44.8 47.6" />
                  <path d="M60.2 47.6 Q64.5 42 68.8 47.6" />
                </g>
              </g>
              <rect x="35" y="64" width="8" height="6" rx="2.5" fill="#12181a" />
              <rect x="46" y="64" width="8" height="6" rx="2.5" fill="#12181a" />
              <rect x="57" y="64" width="8" height="6" rx="2.5" fill="#12181a" />
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}));
