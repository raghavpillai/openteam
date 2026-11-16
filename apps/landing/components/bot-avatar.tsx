"use client";

import {
  normalizeRobotAvatarShape,
  type BotAvatarMode,
  type RobotAvatarShape,
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
import {
  loadedRobotAvatarGaze,
  loadRobotAvatarGaze,
  loadRobotAvatarGazeWhenIdle,
  robotAvatarGazeScope,
  type RobotAvatarGaze,
} from "@openteam/design-tokens/robot-avatar-gaze-scope";
import { createRobotAvatarMotion } from "@openteam/design-tokens/robot-avatar-motion";
import {
  createElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

function renderNode(node: RobotAvatarLayerNode, key: number): React.ReactElement {
  const style = node.attributes.style;
  // The tilted face plate is what gaze turns, as in the desktop avatar.
  const face =
    typeof style === "object" && String((style as Record<string, string>).transform ?? "").includes("perspective");
  return createElement(node.tag, { ...node.attributes, ...(face ? { "data-face": "" } : {}), key }, node.children?.map(renderNode));
}

const glyphs = ROBOT_AVATAR_GLYPHS.map(renderNode);

/** One of four quarter-breaths, so neighbouring robots never breathe in lockstep. */
const phaseOf = (seed: string) => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return ((hash >>> 0) % 4) * 1.15;
};

/**
 * The desktop app's robot: idle loops, fidgets, pokes, neighbours glancing at each other and,
 * with `gaze`, eyes that follow the pointer. Motion runs only while the avatar is on screen.
 */
export function BotAvatar({
  shape = "goggles",
  color = "#ff7a1a",
  size = 32,
  eyeColor,
  className,
  title,
  mode = "idle",
  gaze = "off",
  pokeable = true,
  seed,
}: {
  shape?: RobotAvatarShape;
  color?: string;
  size?: number;
  eyeColor?: string;
  className?: string;
  title?: string;
  mode?: BotAvatarMode;
  /** hover: looks at the pointer over its row. follow: watches the pointer anywhere. */
  gaze?: RobotAvatarGaze;
  /** Pressing the robot plays a little reaction. */
  pokeable?: boolean;
  /** Offsets the idle loops, so a list of robots never moves in unison. */
  seed?: string;
}) {
  const robot = normalizeRobotAvatarShape(shape);
  const id = useId();
  const ref = useRef<SVGSVGElement>(null);
  const motion = useRef<ReturnType<typeof createRobotAvatarMotion> | null>(null);
  const [visible, setVisible] = useState(false);
  const animated = mode !== "still";

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
    motion.current?.setMode(visible ? mode : "still", visible && !document.hidden);
  }, [mode, visible, robot]);

  useEffect(() => {
    if (!animated) return;
    const element = ref.current;
    if (!element) return;
    let inViewport = false;
    const sync = () => setVisible(inViewport && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
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
    // The gaze module loads once the page settles, or as soon as something points at a robot.
    const wake = (event?: Event) => {
      scope.removeEventListener("pointerenter", wake);
      scope.removeEventListener("pointerdown", wake);
      void loadRobotAvatarGaze().then(
        () => {
          if (!disposed) attach(event as PointerEvent | undefined);
        },
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
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      className={`robot-avatar ${className ?? ""}`}
      data-avatar-mode="still"
      ref={ref}
      focusable="false"
      data-avatar-shape={robot}
      viewBox={ROBOT_AVATAR_VIEW_BOX}
      width={size}
      height={size}
      style={
        {
          flex: "0 0 auto",
          color,
          "--robot-face": eyeColor ?? robotAvatarFaceColor(color),
          "--robot-tempo": `${robotAvatarTempo(robot)}s`,
          "--robot-delay": `${-phaseOf(seed ?? id)}s`,
        } as CSSProperties
      }
    >
      {title ? <title>{title}</title> : null}
      {/* Same layers as the desktop avatar: busy modes fold the robot into these glyphs. */}
      <g className="robot-avatar-rig">
        <g className="robot-avatar-body">{robotAvatarLayers(robot).map(renderNode)}</g>
        <g className="robot-avatar-glyph">{glyphs}</g>
      </g>
    </svg>
  );
}
