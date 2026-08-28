// Source-owned adaptation of AI Elements shimmer.tsx.
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Shimmer({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "bg-[linear-gradient(100deg,var(--muted-foreground)_0%,var(--muted-foreground)_42%,var(--foreground)_50%,var(--muted-foreground)_58%,var(--muted-foreground)_100%)] bg-[length:300%_100%] bg-clip-text text-transparent motion-safe:animate-[working-status-shimmer_1.8s_linear_infinite]",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
