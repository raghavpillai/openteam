import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Shared empty state: a serif title that reads like a sentence, one line of
 * plain-language help, and (optionally) one action.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  compact = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-10",
        className
      )}
    >
      {icon && <div className="mb-1 text-ink-3">{icon}</div>}
      <p
        className={cn(
          "font-display text-ink",
          compact ? "text-[20px] leading-6" : "text-[26px] leading-8 tracking-[-0.01em]"
        )}
      >
        {title}
      </p>
      {description && (
        <p className="max-w-[36ch] text-[13px] leading-5 text-ink-2">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
