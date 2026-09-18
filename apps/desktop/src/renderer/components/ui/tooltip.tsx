import { Tooltip as TooltipPrimitive } from "radix-ui";
import {
  type ComponentProps,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";

const InstantDismissContext = createContext(false);

export function Tooltip({ open, defaultOpen = false, onOpenChange, children, ...props }: ComponentProps<typeof TooltipPrimitive.Root>) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const [instantDismiss, setInstantDismiss] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = open ?? localOpen;
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const changeOpen = useCallback((next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  useEffect(() => {
    if (!visible) { cancelClose(); return; }
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      cancelClose();
      setInstantDismiss(true);
      changeOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
    };
  }, [visible, changeOpen, cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);
  return (
    <InstantDismissContext.Provider value={instantDismiss}>
      <TooltipPrimitive.Root {...props} disableHoverableContent open={visible} onOpenChange={(next) => {
        cancelClose();
        if (next) { setInstantDismiss(false); changeOpen(true); }
        else closeTimer.current = setTimeout(() => changeOpen(false), 100);
      }}>
        {children}
      </TooltipPrimitive.Root>
    </InstantDismissContext.Provider>
  );
}
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 0,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

export function TooltipContent({
  className,
  sideOffset = 7,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  const instantDismiss = useContext(InstantDismissContext);
  // Unmount the portal itself so Radix Presence cannot retain an exit animation
  // after a click or Escape dismissal.
  if (instantDismiss) return null;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn(
          "floating-surface z-[100] w-fit max-w-[320px] origin-(--radix-tooltip-content-transform-origin) rounded-[6px] border-[0.5px] border-input bg-popover px-1.5 py-1 text-[12px] font-normal leading-4 text-popover-foreground shadow-[0_2px_7px_rgba(0,0,0,0.16)]",
          className
        )}
        sideOffset={sideOffset}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
