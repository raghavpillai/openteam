import {
  BOT_AVATAR_ARTWORK,
  BOT_AVATAR_VIEW_BOX,
  botAvatarEyeRects,
  botAvatarEyeTransform,
} from "@openteam/design-tokens/bot-avatar-artwork";

export type BotShape = "blob" | "circle" | "drop" | "cloud" | "square" | "hexagon";

export function BotAvatar({
  shape = "blob",
  color = "#ff7a1a",
  size = 32,
  eyeColor = "#ffffff",
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
  /** Blink every few seconds (only when motion is enabled). */
  blink?: boolean;
  /** Offset in ms so a group of bots does not blink in unison. */
  blinkDelay?: number;
}) {
  const art = BOT_AVATAR_ARTWORK[shape];
  const eyes = botAvatarEyeRects(art.eyes);
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      className={className}
      viewBox={BOT_AVATAR_VIEW_BOX}
      width={size}
      height={size}
      style={{ flex: "0 0 auto" }}
    >
      {title ? <title>{title}</title> : null}
      <g fill={color}>
        {art.body.kind === "circle" ? (
          <circle cx={art.body.cx} cy={art.body.cy} r={art.body.r} />
        ) : (
          <path d={art.body.d} transform={art.body.transform} />
        )}
      </g>
      <g
        fill={eyeColor}
        className={blink ? "eyes-blink" : undefined}
        style={blink ? ({ "--d": `${blinkDelay}ms` } as React.CSSProperties) : undefined}
      >
        {eyes.map((e, i) => (
          <rect
            key={i}
            x={e.x}
            y={e.y}
            width={e.width}
            height={e.height}
            rx={e.rx}
            transform={botAvatarEyeTransform(e)}
          />
        ))}
      </g>
    </svg>
  );
}
