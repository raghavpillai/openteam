import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30",
        type === "file" &&
          "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className
      )}
      type={type}
      {...props}
    />
  );
}
