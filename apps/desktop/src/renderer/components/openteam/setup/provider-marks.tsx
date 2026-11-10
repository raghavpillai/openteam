import type { CSSProperties } from "react";

// Official provider marks (downloaded 2026-10-20): Claude's spark from claude.ai, the OpenAI
// and Anthropic marks from openrouter.ai's model icons, OpenRouter's logo from its site
// header, and Deepgram's D from its wordmark. Path coordinates are rounded to 0.1–0.01 units
// (no visible change at 256 px). The one-colour marks follow currentColor, so they invert in
// dark mode. The ChatGPT and Claude app icons are in app-icons.tsx.

type MarkProps = { size?: number; className?: string };

function mark(viewBox: string, d: string, fill = "currentColor") {
  return function Mark({ size = 20, className }: MarkProps) {
    return (
      <svg
        aria-hidden="true"
        className={className}
        fill={fill}
        height={size}
        viewBox={viewBox}
        width={size}
      >
        <path d={d} />
      </svg>
    );
  };
}

export const OpenAIMark = mark(
  "-11.75 -9.75 279.5 279.5",
  "M239.18 106.2a64.72 64.72 0 0 0-5.58-53.1C219.45 28.46 191 15.78 163.21 21.74A65.59 65.59 0 0 0 52.1 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.6-11.06 55.63 8.03 76.74a64.67 64.67 0 0 0 5.53 53.1c14.17 24.65 42.64 37.32 70.45 31.36a64.72 64.72 0 0 0 48.75 21.74c28.48.03 53.71-18.36 62.41-45.48a64.77 64.77 0 0 0 43.23-31.36c14.14-24.56 10.88-55.42-8.08-76.48Zm-97.56 136.34a48.4 48.4 0 0 1-31.11-11.26l1.53-.87 51.67-29.82a8.6 8.6 0 0 0 4.25-7.37v-72.85l21.84 12.64c.22.11.37.32.41.56v60.37c-.06 26.82-21.78 48.55-48.6 48.6Zm-104.47-44.61a48.34 48.34 0 0 1-5.78-32.59l1.53.92 51.72 29.83a8.34 8.34 0 0 0 8.44 0l63.18-36.42v25.22a.87.87 0 0 1-.36.67l-52.34 30.18c-23.26 13.4-52.97 5.43-66.4-17.8ZM23.55 85.38a48.5 48.5 0 0 1 25.58-21.33v61.39a8.29 8.29 0 0 0 4.2 7.32l62.87 36.27-21.84 12.64a.82.82 0 0 1-.77 0L41.35 151.53c-23.21-13.45-31.17-43.14-17.8-66.41v.26Zm179.47 41.7-63.08-36.63L161.73 77.86a.82.82 0 0 1 .77 0l52.23 30.18a48.6 48.6 0 0 1-7.32 87.64v-61.39a8.54 8.54 0 0 0-4.4-7.21Zm21.74-32.69-1.53-.92-51.62-30.08a8.39 8.39 0 0 0-8.49 0L99.98 99.81V74.59a.72.72 0 0 1 .31-.67l52.23-30.13a48.65 48.65 0 0 1 72.24 50.39v.2ZM88.06 139.1l-21.84-12.59a.87.87 0 0 1-.41-.61V65.69a48.65 48.65 0 0 1 79.76-37.35l-1.53.87-51.67 29.82a8.6 8.6 0 0 0-4.25 7.37l-.05 72.7Zm11.87-25.58 28.14-16.22 28.19 16.22v32.43l-28.09 16.22-28.19-16.22-.05-32.43Z"
);
export const ClaudeMark = mark(
  "0 0 248 248",
  "M52.4 162.9L98.8 136.9L99.5 134.6L98.8 133.3H96.5L88.7 132.9L62.2 132.2L39.3 131.2L17 130L11.4 128.8L6.2 121.9L6.7 118.4L11.4 115.3L18.2 115.8L33.1 116.9L55.5 118.4L71.7 119.4L95.7 121.9H99.5L100.1 120.3L98.8 119.4L97.8 118.4L74.6 102.7L49.5 86.2L36.4 76.6L29.4 71.8L25.8 67.3L24.3 57.4L30.7 50.3L39.3 50.9L41.5 51.5L50.3 58.2L69 72.7L93.4 90.7L97 93.6L98.4 92.7L98.7 92L97 89.3L83.8 65.3L69.6 40.8L63.3 30.7L61.6 24.6C61 22.1 60.6 20 60.6 17.4L67.8 7.5L71.9 6.2L81.7 7.5L85.8 11L91.9 25L101.7 46.8L117 76.6L121.5 85.5L123.9 93.6L124.8 96.1H126.3V94.7L127.6 77.9L129.9 57.4L132.2 30.9L132.9 23.5L136.6 14.5L144 9.6L149.7 12.3L154.4 19.1L153.8 23.5L151 41.6L145.5 70.1L142 89.3H144L146.4 86.8L156.1 74L172.3 53.7L179.4 45.7L187.8 36.8L193.2 32.5H203.3L210.7 43.7L207.4 55.1L197 68.3L188.3 79.6L175.9 96.2L168.2 109.6L168.9 110.7L170.7 110.5L198.8 104.5L213.9 101.8L232 98.7L240.1 102.5L241 106.4L237.9 114.3L218.5 119L195.8 123.6L162.1 131.6L161.7 131.9L162.1 132.5L177.4 133.9L183.9 134.3H199.8L229.4 136.5L237.2 141.6L241.8 147.9L241 152.7L229.1 158.7L213 155L175.4 146L162.6 142.8H160.8V143.8L171.5 154.4L191.2 172.1L215.8 195L217.1 200.7L213.9 205.2L210.6 204.7L188.9 188.4L180.5 181.1L161.7 165.1H160.4V166.8L164.8 173.2L187.8 207.8L188.9 218.4L187.3 221.8L181.3 224L174.8 222.8L161.2 203.8L147.3 182.5L136.1 163.3L134.7 164.2L128.1 235.4L125 239.1L117.9 241.8L111.9 237.3L108.7 230L111.9 215.5L115.7 196.5L118.8 181.5L121.6 162.9L123.3 156.6L123.1 156.2L121.8 156.4L107.7 175.8L86.3 204.7L69.4 222.8L65.3 224.4L58.3 220.8L58.9 214.3L62.9 208.5L86.3 178.7L100.4 160.2L109.6 149.5L109.5 148L109 147.9L46.7 188.5L35.6 189.9L30.8 185.4L31.4 178.1L33.7 175.8L52.4 162.9Z",
  "#D97757"
);
export const AnthropicMark = mark(
  "106 106 300 300",
  "M318.7 149.8h-43.4l79 212.4 43.4 0-79-212.4zm-125.3 0l-79 212.4h44.3l15.9-44.6 82.8 0 16.1 44.6h44.3l-79.1-212.4h-45.3zm-4.3 128.3l26.9-74.7 27.1 74.7h-54z"
);
export const OpenRouterMark = mark(
  "19.82 -36.43 365.56 365.56",
  "M303.95 17.2c42.8 0 77.49 34.69 77.49 77.49s-34.69 77.49-77.49 77.49l76.86 76.86c9.76 9.76 2.85 26.46-10.96 26.46h-220.88c-71.33 0-129.15-57.82-129.15-129.15S77.64 17.2 148.97 17.2h154.98ZM148.97 68.86c-42.8 0-77.49 34.69-77.49 77.49s34.69 77.49 77.49 77.49 77.49-34.69 77.49-77.49-34.69-77.49-77.49-77.49Z"
);
export const DeepgramMark = mark(
  "-2.1 .85 24 24",
  "M16.63 5.24C18.69 7.33 19.8 10.09 19.75 13.02V13.02C19.66 18.91 14.71 23.7 8.71 23.7H.28C.12 23.7.04 23.51.16 23.39L4.26 19.27C4.33 19.2 4.42 19.16 4.51 19.16H8.79C12.23 19.16 15.11 16.42 15.21 13.04C15.26 11.32 14.63 9.69 13.43 8.46C12.22 7.22 10.61 6.54 8.89 6.54H4.54V13.56C4.54 13.62 4.5 13.67 4.43 13.67H.11C.05 13.67 0 13.62 0 13.56V2.11C0 2.05.05 2 .11 2H8.89C11.82 2 14.57 3.15 16.63 5.24Z"
);

// API providers sit on their tiles, so they line up with the app icons (the tiles' colours).
const TILES = {
  openai: { Mark: OpenAIMark, background: "#000000", color: "#ffffff", scale: 0.66 },
  anthropic: { Mark: AnthropicMark, background: "#CC9B7A", color: "#1F1F1E", scale: 0.58 },
  openrouter: { Mark: OpenRouterMark, background: "#000000", color: "#ffffff", scale: 0.61 },
  deepgram: { Mark: DeepgramMark, background: "#080808", color: "#ffffff", scale: 0.7 },
} as const;
export type TileProvider = keyof typeof TILES;

export const isTileProvider = (id: string): id is TileProvider => id in TILES;

/** An API provider's mark on its square tile. */
export function ProviderTile({ provider, size = 40 }: { provider: TileProvider; size?: number }) {
  const { Mark, background, color, scale } = TILES[provider];
  const style: CSSProperties = {
    display: "inline-grid",
    flexShrink: 0,
    width: size,
    height: size,
    placeItems: "center",
    borderRadius: size * 0.22,
    background,
    color,
    boxShadow: "0 0 0 0.5px rgb(255 255 255 / 8%)",
  };
  return (
    <span aria-hidden="true" className="provider-icon" style={style}>
      <Mark size={Math.round(size * scale)} />
    </span>
  );
}

const MARKS: Record<string, ReturnType<typeof mark>> = {
  "openai-codex": OpenAIMark,
  openai: OpenAIMark,
  "claude-code": ClaudeMark,
  anthropic: AnthropicMark,
  openrouter: OpenRouterMark,
  deepgram: DeepgramMark,
};

/** A provider's one-colour mark by its server id, for small inline places; null when unknown. */
export function ProviderMark({ id, size = 14, className }: MarkProps & { id: string }) {
  const Mark = MARKS[id];
  return Mark ? <Mark className={className} size={size} /> : null;
}
