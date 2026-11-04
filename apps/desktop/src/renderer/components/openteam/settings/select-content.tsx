import type { ComponentProps } from "react";
import { cn } from "../../../lib/cn";
import { SelectContent } from "../../ui/select";

export function SettingsSelectContent({
  className,
  ...props
}: ComponentProps<typeof SelectContent>) {
  return (
    <SelectContent
      align="end"
      className={cn(
        "min-w-[200px] max-w-[calc(100vw-16px)] rounded-[12px] border-border/50 shadow-[0_8px_24px_rgba(0,0,0,0.12)] [&_[role=option]]:rounded-[6px] [&_[role=option]]:text-[13px] [&_[role=option]]:leading-5",
        className
      )}
      {...props}
    />
  );
}
