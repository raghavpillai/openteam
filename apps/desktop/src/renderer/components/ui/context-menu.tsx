import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          "z-[100] min-w-44 origin-[var(--radix-context-menu-content-transform-origin)] overflow-hidden rounded-xl border border-input bg-popover p-1.5 text-popover-foreground shadow-[0_4px_14px_rgba(0,0,0,0.12)] outline-none duration-100 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none",
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

type ContextMenuItemProps = ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
};

export function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: ContextMenuItemProps) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "relative flex h-8 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2 text-[13px] outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50 [&_svg]:shrink-0 [&_svg]:text-foreground-secondary",
        variant === "destructive" &&
          "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive [&_svg]:text-destructive",
        className
      )}
      {...props}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn("mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export function ContextMenuSubTrigger({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.SubTrigger>) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(
        "relative flex h-8 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2 text-[13px] outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent [&_svg]:shrink-0 [&_svg]:text-foreground-secondary",
        className
      )}
      {...props}
    />
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        className={cn(
          "z-[101] min-w-44 origin-[var(--radix-context-menu-content-transform-origin)] overflow-hidden rounded-xl border border-input bg-popover p-1.5 text-popover-foreground shadow-[0_4px_14px_rgba(0,0,0,0.12)] outline-none duration-100 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none",
          className
        )}
        sideOffset={5}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}
