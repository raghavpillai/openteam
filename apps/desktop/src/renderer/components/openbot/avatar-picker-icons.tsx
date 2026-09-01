import { type BotAvatarShape, DEFAULT_BOT_AVATAR } from "@openbot/contracts/bot-avatar";
import {
  BOT_AVATAR_ARTWORK,
  BOT_AVATAR_VIEW_BOX,
  botAvatarEyeRects,
  botAvatarEyeTransform,
  type BotAvatarEyes,
} from "@openbot/design-tokens/bot-avatar-artwork";
import { memo, type SVGProps } from "react";

export {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarColor,
  type BotAvatarShape,
  DEFAULT_BOT_AVATAR,
  normalizeBotAvatarShape,
} from "@openbot/contracts/bot-avatar";

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

export function botAvatarSwatchBackground(color: string): string {
  return `linear-gradient(45deg, color-mix(in srgb, ${color}, black 9%), color-mix(in srgb, ${color}, white 11%))`;
}

function EyePair({ color = "#fff", ...eyes }: BotAvatarEyes & { color?: string }) {
  const [leftEye, rightEye] = botAvatarEyeRects(eyes);
  return (
    <g fill={color}>
      <rect
        height={leftEye.height}
        rx={leftEye.rx}
        transform={botAvatarEyeTransform(leftEye)}
        width={leftEye.width}
        x={leftEye.x}
        y={leftEye.y}
      />
      <rect
        height={rightEye.height}
        rx={rightEye.rx}
        transform={botAvatarEyeTransform(rightEye)}
        width={rightEye.width}
        x={rightEye.x}
        y={rightEye.y}
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
  const artwork = BOT_AVATAR_ARTWORK[shape];
  const bodyProps = {
    fill: color,
    paintOrder: "stroke" as const,
    stroke: outlineColor ?? "none",
    strokeLinejoin: "round" as const,
    strokeWidth: outlineColor ? outlineWidth : 0,
  };
  return (
    <>
      {artwork.body.kind === "circle" ? (
        <circle {...bodyProps} cx={artwork.body.cx} cy={artwork.body.cy} r={artwork.body.r} />
      ) : (
        <path {...bodyProps} d={artwork.body.d} transform={artwork.body.transform} />
      )}
      <EyePair {...artwork.eyes} color={eyeColor} />
    </>
  );
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
    <svg aria-hidden="true" focusable="false" viewBox={BOT_AVATAR_VIEW_BOX} {...props}>
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
