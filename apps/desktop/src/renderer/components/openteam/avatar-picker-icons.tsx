import {
  type BotAvatarShape as LegacyBotAvatarShape,
  DEFAULT_BOT_AVATAR,
} from "@openteam/contracts/bot-avatar";
import {
  createElement,
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type SVGProps,
} from "react";
import {
  ROBOT_AVATAR_LABELS,
  ROBOT_AVATAR_SHAPES,
  normalizeRobotAvatarShape,
  type RobotAvatarShape,
  type BotAvatarMode,
} from "@openteam/contracts/robot-avatar";
import {
  ROBOT_AVATAR_ARTWORK,
  ROBOT_AVATAR_VIEW_BOX,
  robotAvatarFaceColor,
  robotAvatarTempo,
  type RobotAvatarNode,
} from "@openteam/design-tokens/robot-avatar-artwork";
import "@openteam/design-tokens/robot-avatar.css";

export {
  BOT_AVATAR_COLORS,
  type BotAvatarColor,
  DEFAULT_BOT_AVATAR,
} from "@openteam/contracts/bot-avatar";
export const BOT_AVATAR_SHAPES = ROBOT_AVATAR_SHAPES;
export const BOT_AVATAR_SHAPE_LABELS = ROBOT_AVATAR_LABELS;
export const normalizeBotAvatarShape = normalizeRobotAvatarShape;
export type BotAvatarShape = RobotAvatarShape | LegacyBotAvatarShape;
export type { BotAvatarMode } from "@openteam/contracts/robot-avatar";

export function botAvatarSwatchBackground(color: string): string {
  return `linear-gradient(45deg, color-mix(in srgb, ${color}, black 9%), color-mix(in srgb, ${color}, white 11%))`;
}

function renderRobotNode(node: RobotAvatarNode, key: number): React.ReactElement {
  return createElement(node.tag, { ...node.attributes, key }, node.children?.map(renderRobotNode));
}
const artwork = Object.fromEntries(
  ROBOT_AVATAR_SHAPES.map((shape) => [shape, ROBOT_AVATAR_ARTWORK[shape].map(renderRobotNode)])
);

export type BotAvatarGlyphProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  shape?: BotAvatarShape;
  color?: string;
  eyeColor?: string;
  outlineColor?: string;
  outlineWidth?: number;
  mode?: BotAvatarMode;
};

/** Shared by chat identities, profile previews, and every picker option. */
export const BotAvatarGlyph = memo(function BotAvatarGlyph({
  shape = DEFAULT_BOT_AVATAR.shape,
  color = DEFAULT_BOT_AVATAR.color,
  eyeColor,
  outlineColor,
  outlineWidth = 0,
  mode = "still",
  className,
  style,
  ...props
}: BotAvatarGlyphProps) {
  const robot = normalizeRobotAvatarShape(shape);
  const outlineId = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (mode === "still") return;
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
  }, [mode]);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={ROBOT_AVATAR_VIEW_BOX}
      {...props}
      className={`robot-avatar ${className ?? ""}`}
      data-avatar-mode={mode === "still" || !visible ? "still" : mode}
      data-avatar-shape={robot}
      ref={ref}
      style={
        {
          color,
          "--robot-face": eyeColor ?? robotAvatarFaceColor(color),
          "--robot-tempo": `${robotAvatarTempo(robot)}s`,
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
        <g className="robot-avatar-body">{artwork[robot]}</g>
      </g>
    </svg>
  );
});
