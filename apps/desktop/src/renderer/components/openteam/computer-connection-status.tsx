import type { ReactNode } from "react";
import { LoadingOrb } from "../ui/loading-orb";
import { cn } from "../../lib/cn";
import "./computer-connection-status.css";

export function ComputerConnectionStatus({
  children,
  loading = true,
  compact = false,
  subtitle,
  className,
}: {
  children: ReactNode;
  loading?: boolean;
  compact?: boolean;
  subtitle?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex flex-col items-center justify-center gap-2",
        !loading && (compact ? "text-xs" : "text-[18px] font-medium"),
        className
      )}
      role="status"
    >
      {loading ? (
        <>
          <LoadingOrb state="connecting" size={20} theme="dark" aria-hidden="true" />
          <span className="computer-connection-subtitle">{subtitle ?? children}</span>
        </>
      ) : children}
    </span>
  );
}
