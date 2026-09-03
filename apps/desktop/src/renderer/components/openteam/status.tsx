import type { BotView, RunView } from "@openteam/contracts";
import { cn } from "../../lib/cn";

/**
 * One status vocabulary for the whole app. Every place that shows a bot's
 * state uses the same word and the same color:
 *   working   → green   "Working"
 *   attention → amber   "Needs you"
 *   starting  → accent  "Starting"
 *   failed    → red     "Setup failed"
 *   idle      → gray    "Idle"
 */
export type BotPresence = "working" | "attention" | "starting" | "failed" | "idle";

export const presenceLabel: Record<BotPresence, string> = {
  working: "Working",
  attention: "Needs you",
  starting: "Starting",
  failed: "Setup failed",
  idle: "Idle",
};

export function botPresence(
  bot: Pick<BotView, "status"> | undefined,
  run: Pick<RunView, "status"> | undefined,
  hasActiveTask = false
): BotPresence {
  if (bot?.status === "failed") return "failed";
  if (bot?.status === "provisioning") return "starting";
  if (run?.status === "waiting_approval") return "attention";
  if (run || hasActiveTask) return "working";
  return "idle";
}

const dotClass: Record<BotPresence, string> = {
  working: "bg-live",
  attention: "bg-attention",
  starting: "bg-accent",
  failed: "bg-danger",
  idle: "bg-ink-3/60",
};

const textClass: Record<BotPresence, string> = {
  working: "text-live",
  attention: "text-attention",
  starting: "text-accent",
  failed: "text-danger",
  idle: "text-ink-3",
};

export function StatusDot({
  presence,
  className,
  pulse = presence === "working",
  size = 7,
  label,
  style,
  ...rest
}: {
  presence: BotPresence;
  className?: string;
  pulse?: boolean;
  size?: number;
  label?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children">) {
  return (
    <span
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={cn(
        "inline-block shrink-0 rounded-full",
        dotClass[presence],
        pulse && "live-pulse",
        className
      )}
      role={label ? "img" : undefined}
      style={{ width: size, height: size, ...style }}
      {...rest}
    />
  );
}

export function StatusText({
  presence,
  children,
  className,
}: {
  presence: BotPresence;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[12px]", textClass[presence], className)}
    >
      <StatusDot presence={presence} size={6} />
      {children ?? presenceLabel[presence]}
    </span>
  );
}
