import type { BotAvatarShape } from "@openteam/contracts/bot-avatar";
import { normalizeRobotAvatarShape, type RobotAvatarShape } from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_ARTWORK,
  ROBOT_AVATAR_VIEW_BOX,
  robotAvatarFaceColor,
  robotAvatarTempo,
  type RobotAvatarNode,
} from "@openteam/design-tokens/robot-avatar-artwork";
import { createElement, type CSSProperties } from "react";

export type BotShape = RobotAvatarShape | BotAvatarShape;

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
  blink = false,
  blinkDelay = 0,
}: {
  shape?: BotShape;
  color?: string;
  size?: number;
  eyeColor?: string;
  className?: string;
  title?: string;
  /** Animate the robot's idle pose when motion is enabled. */
  blink?: boolean;
  /** Offset in ms so a group of bots does not blink in unison. */
  blinkDelay?: number;
}) {
  const robot = normalizeRobotAvatarShape(shape);
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      className={`robot-avatar ${className ?? ""}`}
      data-avatar-mode={blink ? "idle" : "still"}
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
