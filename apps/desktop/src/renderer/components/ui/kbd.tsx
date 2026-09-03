import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Keyboard hint: mono, hairline, never larger than the surrounding text. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong bg-raised px-1 font-mono text-[10.5px] font-medium leading-none text-ink-2",
        className
      )}
      {...props}
    />
  );
}
