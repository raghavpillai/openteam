import { type BotAvatarShape, DEFAULT_BOT_AVATAR } from "@openbot/contracts";
import { memo, type SVGProps } from "react";

export {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarColor,
  type BotAvatarShape,
  DEFAULT_BOT_AVATAR,
  normalizeBotAvatarShape,
} from "@openbot/contracts";

export const BOT_AVATAR_SHAPE_LABELS = {
  circle: "Circle",
  blob: "Round",
  square: "Square",
  pill: "Pill",
  triangle: "Triangle",
  hexagon: "Hexagon",
  cloud: "Cloud",
  drop: "Drop",
} as const satisfies Record<BotAvatarShape, string>;

/**
 * The picker swatches have a restrained upper-right highlight and lower-left
 * shade in the reference. The Bot artwork itself remains a solid fill.
 */
export function botAvatarSwatchBackground(color: string): string {
  return `linear-gradient(45deg, color-mix(in srgb, ${color}, black 9%), color-mix(in srgb, ${color}, white 11%))`;
}

type EyePairProps = {
  color?: string;
  leftHeight?: number;
  leftWidth?: number;
  left: readonly [x: number, y: number];
  rightHeight?: number;
  rightWidth?: number;
  right: readonly [x: number, y: number];
};

function EyePair({
  color = "#fff",
  left,
  leftHeight = 6.4,
  leftWidth = 3.75,
  right,
  rightHeight = 6.4,
  rightWidth = 2.9,
}: EyePairProps) {
  const leftX = left[0] + 0.175;
  const leftY = left[1] + 0.1;
  const rightX = right[0] + 1.3;
  const rightY = right[1] - 0.25;
  return (
    <g fill={color}>
      <rect
        height={leftHeight}
        rx={leftWidth / 2}
        transform={`rotate(-16 ${leftX + leftWidth / 2} ${leftY + leftHeight / 2})`}
        width={leftWidth}
        x={leftX}
        y={leftY}
      />
      <rect
        height={rightHeight}
        rx={rightWidth / 2}
        transform={`rotate(-16 ${rightX + rightWidth / 2} ${rightY + rightHeight / 2})`}
        width={rightWidth}
        x={rightX}
        y={rightY}
      />
    </g>
  );
}

function ShapeArtwork({
  shape,
  color,
  eyeColor,
  outlineColor,
  outlineWidth,
}: {
  shape: BotAvatarShape;
  color: string;
  eyeColor: string;
  outlineColor?: string;
  outlineWidth: number;
}) {
  const bodyProps = {
    fill: color,
    paintOrder: "stroke" as const,
    stroke: outlineColor ?? "none",
    strokeLinejoin: "round" as const,
    strokeWidth: outlineColor ? outlineWidth : 0,
  };
  switch (shape) {
    case "circle":
      return (
        <>
          <circle {...bodyProps} cx="20" cy="20" r="18.35" />
          <EyePair color={eyeColor} left={[19, 13]} right={[28.8, 11.8]} />
        </>
      );
    case "blob":
      return (
        <>
          <path
            d="M15 2.8C10.4 3.5 5.1 7 2.3 12 .5 16.5.5 23.8 2.8 27.5 5 32 10.5 34.5 16.5 36.3c4.2 1.05 9.5 1.05 13.5-.2 5.8-2.4 7.6-7 8.4-11.4C39.1 19 36.5 12 32.5 7.5 30.3 3 25 1.5 15 2.8Z"
            {...bodyProps}
            transform="matrix(.995 0 0 .99 .1 .2)"
          />
          <EyePair color={eyeColor} left={[18.9, 12.5]} right={[28.95, 11.55]} />
        </>
      );
    case "square":
      return (
        <>
          <path
            d="M13.6 5h12.8C32.3 5 35 7.7 35 13.6v12.8c0 5.9-2.7 8.6-8.6 8.6H13.6C7.7 35 5 32.3 5 26.4V13.6C5 7.7 7.7 5 13.6 5Z"
            {...bodyProps}
            transform="matrix(1.11 0 0 1.11 -2.2 -2.2)"
          />
          <EyePair
            color={eyeColor}
            left={[18.8, 12.85]}
            leftHeight={7}
            right={[28.05, 12.45]}
            rightWidth={2.7}
          />
        </>
      );
    case "pill":
      return (
        <>
          <path
            d="M13.6 8.5h12.8C33.3 8.5 38 13.5 38 20s-4.7 11.5-11.4 11.5H13.6C6.7 31.5 2 26.5 2 20S6.7 8.5 13.6 8.5Z"
            {...bodyProps}
            transform="matrix(1.095 0 0 1.11 -1.9 -2.2)"
          />
          <EyePair color={eyeColor} left={[18.92, 14.22]} leftWidth={4} right={[29.2, 13.5]} />
        </>
      );
    case "triangle":
      return (
        <>
          <path
            d="M17.3 4.7c.7-1.2 1.5-1.9 2.7-1.9s2 .7 2.7 1.9C27 8 35.8 23 38.5 31c.9 3.2-2.5 6.2-4.2 6.2H5.7C4 37.2.6 34.2 1.5 31 4.2 23 13 8 17.3 4.7Z"
            {...bodyProps}
            transform="matrix(.985 0 0 1 .15 0)"
          />
          <EyePair color={eyeColor} left={[18.45, 18]} right={[26.25, 17.25]} />
        </>
      );
    case "hexagon":
      return (
        <>
          <path
            d="M17.6 1.8a4.8 4.8 0 0 1 4.8 0l13.3 7.3a4 4 0 0 1 1 3.7v14.4a4 4 0 0 1-1.5 3.7l-13.1 7.3a4.2 4.2 0 0 1-4.2 0L4.8 30.9a4 4 0 0 1-2-3.7V12.8a4 4 0 0 1 1.5-3.7l13.3-7.3Z"
            {...bodyProps}
            transform="matrix(.984 0 0 1 .32 0)"
          />
          <EyePair
            color={eyeColor}
            left={[18.78, 12.95]}
            leftHeight={6.7}
            right={[28.55, 11.4]}
            rightHeight={6.9}
          />
        </>
      );
    case "drop":
      return (
        <>
          <path
            d="M19.3 2.7c.4-.5 1-.5 1.4 0C25.5 6.5 35 17.4 34 26c-.7 6.5-7 11.5-14 11.5S6.7 32.5 6 26C5 17.4 14.5 6.5 19.3 2.7Z"
            {...bodyProps}
            transform="matrix(1.11 0 0 1.13 -2.2 -3.13)"
          />
          <EyePair color={eyeColor} left={[18.78, 16.95]} right={[27.55, 15.73]} rightWidth={2.7} />
        </>
      );
    case "cloud":
      return (
        <>
          <path
            d="M8.2 32.3C3.6 31.9.8 28.6 1.5 24.2c.5-3.5 2.8-6.1 6-7-.4-5.1 3.3-9.6 8.4-10.2 3.3-.4 6.1.7 8.1 2.9 2-1.5 4.5-2.1 7.1-1.3 4.3 1.3 6.9 5.5 6.1 9.8 2 2 3 5 2 7.9-1.1 3.3-4.1 5.4-7.4 5.5-2.2 2.7-5.9 3.5-9 2-3.5 2.4-8.3 1.9-11.2-1-1.1.2-2.3.1-3.4-.5Z"
            {...bodyProps}
            transform="matrix(1.04 0 0 1.12 -.8 -2.62)"
          />
          <EyePair color={eyeColor} left={[19.33, 15.78]} right={[27.6, 14.28]} />
        </>
      );
  }
}

export type BotAvatarGlyphProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  shape?: BotAvatarShape;
  color?: string;
  eyeColor?: string;
  outlineColor?: string;
  outlineWidth?: number;
};

/** A decorative, scale-independent Bot silhouette for avatars and the picker. */
export const BotAvatarGlyph = memo(function BotAvatarGlyph({
  shape = DEFAULT_BOT_AVATAR.shape,
  color = DEFAULT_BOT_AVATAR.color,
  eyeColor = "#fff",
  outlineColor,
  outlineWidth = 0,
  ...props
}: BotAvatarGlyphProps) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 40 40" {...props}>
      <ShapeArtwork
        color={color}
        eyeColor={eyeColor}
        outlineColor={outlineColor}
        outlineWidth={outlineWidth}
        shape={shape}
      />
    </svg>
  );
});
