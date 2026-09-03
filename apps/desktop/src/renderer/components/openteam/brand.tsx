import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** The OpenTeam blob mark in a single color; matches the boot splash. */
export function BotGlyphIcon({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="none"
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M15 2.8C10.4 3.5 5.1 7 2.3 12 .5 16.5.5 23.8 2.8 27.5 5 32 10.5 34.5 16.5 36.3c4.2 1.05 9.5 1.05 13.5-.2 5.8-2.4 7.6-7 8.4-11.4C39.1 19 36.5 12 32.5 7.5 30.3 3 25 1.5 15 2.8Z"
        fill="currentColor"
      />
      <g fill="var(--surface)">
        <rect
          height="6.4"
          rx="1.875"
          transform="rotate(-16 21.05 15.8)"
          width="3.75"
          x="19.075"
          y="12.6"
        />
        <rect
          height="6.4"
          rx="1.45"
          transform="rotate(-16 31.7 14.5)"
          width="2.9"
          x="30.25"
          y="11.3"
        />
      </g>
    </svg>
  );
}

/** Wordmark: glyph + "OpenTeam" in the display serif. */
export function Wordmark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-ink", className)}>
      <BotGlyphIcon style={{ width: size, height: size }} />
      <span
        className="font-display tracking-[-0.01em]"
        style={{ fontSize: Math.round(size * 1.15), lineHeight: 1 }}
      >
        OpenTeam
      </span>
    </span>
  );
}
