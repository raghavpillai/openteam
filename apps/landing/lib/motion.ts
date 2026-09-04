import type { CSSProperties } from "react";

/** Inline style that orders a child inside a staggered `Reveal` (see components/motion.tsx). */
export const order = (i: number) => ({ "--i": i }) as CSSProperties;
