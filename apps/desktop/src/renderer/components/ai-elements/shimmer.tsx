// Source-owned adaptation of AI Elements shimmer.tsx.
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Shimmer({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "animate-pulse bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
