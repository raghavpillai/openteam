/**
 * The Bot mark, drawn from the same artwork the desktop and iPhone apps use
 * (packages/design-tokens/src/bot-avatar-artwork.ts). Copied inline so the
 * landing site stays a plain client with no workspace imports.
 */
export type BotShape = "blob" | "circle" | "drop" | "cloud" | "square" | "hexagon";

type Eyes = {
  left: readonly [number, number];
  right: readonly [number, number];
  leftHeight?: number;
  leftWidth?: number;
  rightHeight?: number;
  rightWidth?: number;
};

const ARTWORK: Record<BotShape, { body: React.ReactNode; eyes: Eyes }> = {
  blob: {
    body: (
      <path
        d="M15 2.8C10.4 3.5 5.1 7 2.3 12 .5 16.5.5 23.8 2.8 27.5 5 32 10.5 34.5 16.5 36.3c4.2 1.05 9.5 1.05 13.5-.2 5.8-2.4 7.6-7 8.4-11.4C39.1 19 36.5 12 32.5 7.5 30.3 3 25 1.5 15 2.8Z"
        transform="matrix(.995 0 0 .99 .1 .2)"
      />
    ),
    eyes: { left: [18.9, 12.5], right: [28.95, 11.55] },
  },
  circle: {
    body: <circle cx="20" cy="20" r="18.35" />,
    eyes: { left: [19, 13], right: [28.8, 11.8] },
  },
  drop: {
    body: (
      <path
        d="M19.3 2.7c.4-.5 1-.5 1.4 0C25.5 6.5 35 17.4 34 26c-.7 6.5-7 11.5-14 11.5S6.7 32.5 6 26C5 17.4 14.5 6.5 19.3 2.7Z"
        transform="matrix(1.11 0 0 1.13 -2.2 -3.13)"
      />
    ),
    eyes: { left: [18.78, 16.95], right: [27.55, 15.73], rightWidth: 2.7 },
  },
  cloud: {
    body: (
      <path
        d="M8.2 32.3C3.6 31.9.8 28.6 1.5 24.2c.5-3.5 2.8-6.1 6-7-.4-5.1 3.3-9.6 8.4-10.2 3.3-.4 6.1.7 8.1 2.9 2-1.5 4.5-2.1 7.1-1.3 4.3 1.3 6.9 5.5 6.1 9.8 2 2 3 5 2 7.9-1.1 3.3-4.1 5.4-7.4 5.5-2.2 2.7-5.9 3.5-9 2-3.5 2.4-8.3 1.9-11.2-1-1.1.2-2.3.1-3.4-.5Z"
        transform="matrix(1.04 0 0 1.12 -.8 -2.62)"
      />
    ),
    eyes: { left: [19.33, 15.78], right: [27.6, 14.28] },
  },
  square: {
    body: (
      <path
        d="M13.6 5h12.8C32.3 5 35 7.7 35 13.6v12.8c0 5.9-2.7 8.6-8.6 8.6H13.6C7.7 35 5 32.3 5 26.4V13.6C5 7.7 7.7 5 13.6 5Z"
        transform="matrix(1.11 0 0 1.11 -2.2 -2.2)"
      />
    ),
    eyes: { left: [18.8, 12.85], leftHeight: 7, right: [28.05, 12.45], rightWidth: 2.7 },
  },
  hexagon: {
    body: (
      <path
        d="M17.6 1.8a4.8 4.8 0 0 1 4.8 0l13.3 7.3a4 4 0 0 1 1 3.7v14.4a4 4 0 0 1-1.5 3.7l-13.1 7.3a4.2 4.2 0 0 1-4.2 0L4.8 30.9a4 4 0 0 1-2-3.7V12.8a4 4 0 0 1 1.5-3.7l13.3-7.3Z"
        transform="matrix(.984 0 0 1 .32 0)"
      />
    ),
    eyes: { left: [18.78, 12.95], leftHeight: 6.7, right: [28.55, 11.4], rightHeight: 6.9 },
  },
};

function eyeRects({
  left,
  leftHeight = 6.4,
  leftWidth = 3.75,
  right,
  rightHeight = 6.4,
  rightWidth = 2.9,
}: Eyes) {
  const l = { x: left[0] + 0.175, y: left[1] + 0.1, w: leftWidth, h: leftHeight };
  const r = { x: right[0] + 1.3, y: right[1] - 0.25, w: rightWidth, h: rightHeight };
  return [l, r].map((e) => ({
    ...e,
    transform: `rotate(-16 ${e.x + e.w / 2} ${e.y + e.h / 2})`,
  }));
}

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
  const art = ARTWORK[shape];
  const eyes = eyeRects(art.eyes);
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      className={className}
      viewBox="0 0 40 40"
      width={size}
      height={size}
      style={{ flex: "0 0 auto" }}
    >
      {title ? <title>{title}</title> : null}
      <g fill={color}>{art.body}</g>
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
            width={e.w}
            height={e.h}
            rx={e.w / 2}
            transform={e.transform}
          />
        ))}
      </g>
    </svg>
  );
}
