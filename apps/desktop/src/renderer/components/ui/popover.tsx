import { ControlMotion } from "./control-motion";
import { Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const Popover = PopoverPrimitive.Root;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return (
    <ControlMotion enabled={!props.asChild}>
      <PopoverPrimitive.Trigger {...props} />
    </ControlMotion>
  );
}

export function PopoverContent({
  align = "center",
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        className={cn(
          "floating-surface z-[120] w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none",
          className
        )}
        sideOffset={sideOffset}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
