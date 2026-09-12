"use client";

import {
  normalizeRobotAvatarShape,
  type BotAvatarMode,
  type RobotAvatarShape,
} from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_ARTWORK,
  ROBOT_AVATAR_VIEW_BOX,
  robotAvatarFaceColor,
  robotAvatarTempo,
  type RobotAvatarNode,
} from "@openteam/design-tokens/robot-avatar-artwork";
import { createRobotAvatarMotion } from "@openteam/design-tokens/robot-avatar-motion";
import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

function renderNode(node: RobotAvatarNode, key: number): React.ReactElement {
  return createElement(node.tag, { ...node.attributes, key }, node.children?.map(renderNode));
}

export function BotAvatar({
  shape = "goggles",
  color = "#ff7a1a",
  size = 32,
  eyeColor,
  className,
  title,
  mode,
  blink = false,
  blinkDelay = 0,
}: {
  shape?: RobotAvatarShape;
  color?: string;
  size?: number;
  eyeColor?: string;
  className?: string;
  title?: string;
  mode?: BotAvatarMode;
  /** Legacy idle animation shorthand. Explicit mode takes precedence. */
  blink?: boolean;
  /** Offset in ms so a group of bots does not blink in unison. */
  blinkDelay?: number;
}) {
  const robot = normalizeRobotAvatarShape(shape);
  const activity = mode ?? (blink ? "idle" : "still");
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
    motion.current?.setMode(visible ? activity : "still", visible && !document.hidden);
  }, [activity, visible, robot]);

  useEffect(() => {
    if (activity === "still") return;
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
  }, [activity]);
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
          "--robot-delay": `${blinkDelay}ms`,
        } as CSSProperties
      }
    >
      {title ? <title>{title}</title> : null}
      <g className="robot-avatar-body">{ROBOT_AVATAR_ARTWORK[robot].map(renderNode)}</g>
    </svg>
  );
}
