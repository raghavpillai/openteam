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
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "./bot-avatar.css";

type AmbientExpression = "idle" | "thinking" | "talking";

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
  ambient = false,
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
  /** Decorative personality cycle. Leave off for avatars showing real task activity. */
  ambient?: boolean;
}) {
  const robot = normalizeRobotAvatarShape(shape);
  const id = useId();
  const offset = [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1700, 0);
  const [expression, setExpression] = useState<AmbientExpression>("idle");
  const decorative = ambient && mode === undefined;
  const activity = decorative ? (expression === "thinking" ? "thinking" : "idle") : mode ?? (blink ? "idle" : "still");
  const enabled = decorative || activity !== "still";
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
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    let inViewport = false;
    const sync = () => {
      const active = inViewport && !document.hidden;
      setVisible(active);
      if (!active) setExpression("idle");
    };
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
  }, [enabled]);

  useEffect(() => {
    if (!decorative || !visible) return;
    const sequence: readonly [AmbientExpression, number][] = [
      ["thinking", 2800 + offset % 600],
      ["idle", 1800 + offset % 500],
      // Four complete speech loops land back on the resting mouth pose.
      ["talking", 3000],
      ["idle", 3400 + offset],
    ];
    let step = 0;
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      const [next, duration] = sequence[step];
      setExpression(next);
      step = (step + 1) % sequence.length;
      timer = setTimeout(advance, duration);
    };
    timer = setTimeout(advance, 2300 + offset + blinkDelay);
    return () => clearTimeout(timer);
  }, [decorative, visible, offset, blinkDelay]);
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      className={`robot-avatar ${className ?? ""}`}
      data-avatar-mode="still"
      data-avatar-ambient={decorative ? "" : undefined}
      data-avatar-expression={decorative && visible ? expression : undefined}
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
          "--robot-tempo": `${robotAvatarTempo(robot) * (decorative ? 0.48 : 1)}s`,
          "--robot-delay": `${blinkDelay + (visible ? offset : 0)}ms`,
        } as CSSProperties
      }
    >
      {title ? <title>{title}</title> : null}
      <g className="robot-avatar-body">{ROBOT_AVATAR_ARTWORK[robot].map(renderNode)}</g>
    </svg>
  );
}
