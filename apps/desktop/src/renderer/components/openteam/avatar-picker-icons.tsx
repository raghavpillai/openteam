import { isWindowActive, WINDOW_ACTIVITY_EVENT } from "../../lib/window-visibility";
import { DEFAULT_BOT_AVATAR } from "@openteam/contracts/bot-avatar";
import {
  createElement,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type SVGProps,
} from "react";
import {
  ROBOT_AVATAR_SHAPES,
  normalizeRobotAvatarShape,
  type RobotAvatarShape,
  type BotAvatarMode,
} from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_VIEW_BOX,
  robotAvatarFaceColor,
  robotAvatarTempo,
} from "@openteam/design-tokens/robot-avatar-artwork";
import {
  ROBOT_AVATAR_GLYPHS,
  robotAvatarLayers,
  type RobotAvatarLayerNode,
} from "@openteam/design-tokens/robot-avatar-expressions";
import "@openteam/design-tokens/robot-avatar.css";
import { createRobotAvatarMotion } from "../../lib/robot-avatar-motion";
import {
  loadedRobotAvatarGaze,
  loadRobotAvatarGaze,
  loadRobotAvatarGazeWhenIdle,
  robotAvatarGazeScope,
  type RobotAvatarGaze,
} from "../../lib/robot-avatar-gaze-scope";

export function botAvatarSwatchBackground(color: string): string {
  return `linear-gradient(45deg, color-mix(in srgb, ${color}, black 9%), color-mix(in srgb, ${color}, white 11%))`;
}

function renderRobotNode(node: RobotAvatarLayerNode, key: number): React.ReactElement {
  const style = node.attributes.style;
  // The tilted face plate is what gaze shifts, so the eyes keep their perspective.
  const face =
    typeof style === "object" && String((style as Record<string, string>).transform ?? "").includes("perspective");
  return createElement(
    node.tag,
    { ...node.attributes, ...(face ? { "data-face": "" } : {}), key },
    node.children?.map(renderRobotNode)
  );
}
const artwork = Object.fromEntries(
  ROBOT_AVATAR_SHAPES.map((shape) => [shape, robotAvatarLayers(shape).map(renderRobotNode)])
);
const glyphs = ROBOT_AVATAR_GLYPHS.map(renderRobotNode);

/** Busy modes flip often while a run moves between tools; hold each one long enough to read. */
const BUSY_MODES: ReadonlySet<BotAvatarMode> = new Set([
  "working",
  "typing",
  "thinking",
  "searching",
  "generating",
  "connecting",
  "writing",
  "sending",
  "spawning",
]);
const BUSY_DWELL_MS = 900;
/**
 * Some states play out and hand over on their own: a finish plays its happy reaction, a
 * failure its slump, and waking its start, then the robot idles even while the state still
 * holds; a Bot left waiting on the person for two minutes grows drowsy.
 */
const HAND_OFFS: Partial<Record<BotAvatarMode, readonly [after: number, next: BotAvatarMode]>> = {
  done: [5_500, "idle"],
  failed: [3_000, "idle"],
  waking: [1_600, "idle"],
  waiting: [120_000, "drowsy"],
};

function useSteadyMode(mode: BotAvatarMode, handsOff = true): BotAvatarMode {
  const [shown, setShown] = useState(mode);
  const since = useRef(-1);
  if (since.current < 0) since.current = performance.now();
  useEffect(() => {
    if (mode === shown) return;
    const now = performance.now();
    const wait =
      BUSY_MODES.has(mode) && BUSY_MODES.has(shown) ? BUSY_DWELL_MS - (now - since.current) : 0;
    const show = () => {
      since.current = performance.now();
      setShown(mode);
    };
    if (wait <= 0) {
      show();
      return;
    }
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [mode, shown]);
  // Stamped with when its mode began, so a later return to that mode starts over.
  const [handedOff, setHandedOff] = useState<{ since: number; to: BotAvatarMode } | null>(null);
  useEffect(() => {
    // A lasting failure stays slumped; everything else still plays out and settles.
    const handOff = handsOff || shown !== "failed" ? HAND_OFFS[shown] : undefined;
    if (!handOff) return;
    const began = since.current;
    const timer = window.setTimeout(() => setHandedOff({ since: began, to: handOff[1] }), handOff[0]);
    return () => window.clearTimeout(timer);
  }, [shown, handsOff]);
  return handedOff && handedOff.since === since.current ? handedOff.to : shown;
}

export type BotAvatarGlyphProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  shape?: RobotAvatarShape;
  color?: string;
  eyeColor?: string;
  outlineColor?: string;
  outlineWidth?: number;
  mode?: BotAvatarMode;
  /** Where it looks: see RobotAvatarGaze. Most avatars never follow the pointer. */
  gaze?: RobotAvatarGaze;
  /** Pressing the avatar plays a small reaction. */
  pokeable?: boolean;
  /** Holds a mode until told otherwise, where the mode mirrors a lasting state, not an event. */
  lasting?: boolean;
  /** Offsets the idle loops per Bot, so a list of avatars never moves in lockstep. */
  seed?: string;
};

/**
 * A stable phase for a seed string: one of four quarter-breaths. A handful of shared phases
 * looks just as unsynchronised, and Chromium animates a few phase groups far more cheaply
 * than a distinct phase per avatar.
 */
const phaseOf = (seed: string) => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return ((hash >>> 0) % 4) * 1.15;
};

/** Shared by chat identities, profile previews, and every picker option. */
export const BotAvatarGlyph = memo(function BotAvatarGlyph({
  shape = DEFAULT_BOT_AVATAR.shape,
  color = DEFAULT_BOT_AVATAR.color,
  eyeColor,
  outlineColor,
  outlineWidth = 0,
  mode: requestedMode = "still",
  gaze = "off",
  pokeable = true,
  lasting = false,
  seed,
  className,
  style,
  ...props
}: BotAvatarGlyphProps) {
  const robot = normalizeRobotAvatarShape(shape);
  const mode = useSteadyMode(requestedMode, !lasting);
  const outlineId = useId();
  const delay = `${-phaseOf(seed ?? outlineId)}s`;
  const ref = useRef<SVGSVGElement>(null);
  const motion = useRef<ReturnType<typeof createRobotAvatarMotion> | null>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const controller = createRobotAvatarMotion(ref.current);
    motion.current = controller;
    return () => {
      controller.dispose();
      motion.current = null;
    };
  }, [robot]);
  useLayoutEffect(() => {
    motion.current?.setMode(visible ? mode : "still", visible && isWindowActive());
  }, [mode, visible, robot]);
  const animated = requestedMode !== "still";
  useEffect(() => {
    if (!animated) return;
    const element = ref.current;
    if (!element) return;
    let inViewport = false;
    const sync = () => setVisible(inViewport && isWindowActive());
    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(element);
    window.addEventListener(WINDOW_ACTIVITY_EVENT, sync);
    return () => {
      observer.disconnect();
      window.removeEventListener(WINDOW_ACTIVITY_EVENT, sync);
    };
  }, [animated]);
  const interactive = visible && animated && (gaze !== "off" || pokeable);
  useEffect(() => {
    const element = ref.current;
    const controller = motion.current;
    if (!interactive || !element || !controller) return;
    const scope = robotAvatarGazeScope(element);
    let detach: (() => void) | null = null;
    let disposed = false;
    const attach = (initial?: PointerEvent) => {
      const gazeModule = loadedRobotAvatarGaze();
      if (gazeModule && !detach)
        detach = gazeModule.attachRobotAvatarGaze(element, controller, { gaze, pokeable, scope, initial });
    };
    // Until the app settles or something points at an avatar, keep the module unloaded.
    const wake = (event?: Event) => {
      scope.removeEventListener("pointerenter", wake);
      scope.removeEventListener("pointerdown", wake);
      void loadRobotAvatarGaze().then(
        () => {
          if (!disposed) attach(event as PointerEvent | undefined);
        },
        // Without the module the avatar still shows its mode; it only stops reacting.
        () => undefined
      );
    };
    if (loadedRobotAvatarGaze() || gaze === "follow") wake();
    else {
      scope.addEventListener("pointerenter", wake);
      scope.addEventListener("pointerdown", wake);
      void loadRobotAvatarGazeWhenIdle().then(
        () => {
          if (!disposed) wake();
        },
        () => undefined
      );
    }
    return () => {
      disposed = true;
      scope.removeEventListener("pointerenter", wake);
      scope.removeEventListener("pointerdown", wake);
      detach?.();
    };
  }, [interactive, gaze, pokeable, robot]);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={ROBOT_AVATAR_VIEW_BOX}
      {...props}
      className={`robot-avatar ${className ?? ""}`}
      data-avatar-mode="still"
      data-avatar-shape={robot}
      ref={ref}
      style={
        {
          color,
          "--robot-face": eyeColor ?? robotAvatarFaceColor(color),
          "--robot-tempo": `${robotAvatarTempo(robot)}s`,
          "--robot-delay": delay,
          ...style,
        } as CSSProperties
      }
    >
      {outlineColor && outlineWidth > 0 && (
        <defs>
          <filter
            id={outlineId}
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
            colorInterpolationFilters="sRGB"
          >
            <feMorphology
              in="SourceAlpha"
              operator="dilate"
              radius={outlineWidth * 1.25}
              result="expanded"
            />
            <feFlood floodColor={outlineColor} />
            <feComposite in2="expanded" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      )}
      <g filter={outlineColor && outlineWidth > 0 ? `url(#${outlineId})` : undefined}>
        <g className="robot-avatar-rig">
          <g className="robot-avatar-body">{artwork[robot]}</g>
          <g className="robot-avatar-glyph">{glyphs}</g>
        </g>
      </g>
    </svg>
  );
});
