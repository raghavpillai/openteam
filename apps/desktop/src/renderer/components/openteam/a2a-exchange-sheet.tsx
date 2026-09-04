import { useEffect, type AnimationEvent, type ReactNode } from "react";
import type { A2AExchangePhase } from "../../lib/a2a-exchange";

export function A2AExchangeSheet({
  children,
  label,
  onAnimationEnd,
  phase,
}: {
  children: ReactNode;
  label: string;
  onAnimationEnd: () => void;
  phase: A2AExchangePhase;
}) {
  const finishAnimation = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onAnimationEnd();
  };

  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const frame = window.requestAnimationFrame(onAnimationEnd);
    return () => window.cancelAnimationFrame(frame);
  }, [onAnimationEnd, phase]);

  return (
    <div
      aria-label={label}
      className="a2a-exchange-layer"
      data-a2a-exchange-layer=""
      data-state={phase}
      role="region"
    >
      <div
        className="a2a-exchange-sheet"
        data-a2a-exchange-sheet=""
        data-state={phase}
        onAnimationEnd={finishAnimation}
      >
        {children}
      </div>
    </div>
  );
}
