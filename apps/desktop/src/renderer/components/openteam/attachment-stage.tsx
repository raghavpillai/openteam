import { ButtonPrimitive } from "../ui/button-primitive";
import { X } from "lucide-react";
import { type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import { AttachmentStageChannel } from "../../hooks/attachment-stage-channel";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/** An attachment replaces the chat stage, keeping navigation and the composer available. */
export function AttachmentStage({
  open,
  onOpenChange,
  title,
  closeLabel = "Close preview",
  dark = false,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel?: string;
  dark?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const channel = useContext(AttachmentStageChannel);
  const previousChannel = useRef(channel);
  useLayoutEffect(() => {
    if (open && previousChannel.current !== channel) onOpenChange(false);
    previousChannel.current = channel;
  }, [channel, open, onOpenChange]);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !content) return;
    const composer = [...document.querySelectorAll<HTMLElement>("[data-composer-dock] form")].find(
      (element) => element.getBoundingClientRect().width > 0
    );
    if (!composer) return;
    const dock = composer.closest<HTMLElement>("[data-composer-dock]");
    const originalTheme = dock?.getAttribute("data-theme");
    if (dark) dock?.setAttribute("data-theme", "dark");
    const update = () =>
      content.style.setProperty(
        "--attachment-composer-height",
        `${composer.getBoundingClientRect().height}px`
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      if (dark && dock) {
        if (originalTheme == null) dock.removeAttribute("data-theme");
        else dock.setAttribute("data-theme", originalTheme);
      }
    };
  }, [open, content, dark]);
  return (
    <Dialog modal={false} onOpenChange={onOpenChange} open={open}>
      <DialogContent
        ref={setContent}
        className="attachment-stage translate-none"
        data-attachment-stage=""
        data-attachment-tone={dark ? "dark" : "default"}
        onInteractOutside={(event) => {
          // Typing a follow-up keeps the attachment in view. Navigation outside
          // the chat closes it through the normal nonmodal dismiss behavior.
          if (event.target instanceof Element && event.target.closest("[data-composer-dock]"))
            event.preventDefault();
        }}
        showCloseButton={false}
        surface="transparent"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">Preview and download {title}</DialogDescription>
        <header className="attachment-stage-header">
          <ButtonPrimitive
            aria-label={closeLabel}
            className="desktop-elevated-control"
            onClick={() => onOpenChange(false)}
            title="Back to chat"
            type="button"
          >
            <X className="size-4" strokeWidth={1.8} />
          </ButtonPrimitive>
          <div className="attachment-stage-title" title={title}>
            {title}
          </div>
          <div className="attachment-stage-actions">{actions}</div>
        </header>
        {children}
      </DialogContent>
    </Dialog>
  );
}
