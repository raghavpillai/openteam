import { ButtonPrimitive } from "../ui/button-primitive";
import { X } from "lucide-react";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AttachmentStageChannel } from "../../hooks/attachment-stage-channel";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { AttachmentComposer } from "./attachment-composer";

const PreviewTools = createContext<HTMLDivElement | null>(null);
export const AttachmentStageDismiss = createContext<() => void>(() => {});

export function AttachmentStageTools({ children }: { children: ReactNode }) {
  const target = useContext(PreviewTools);
  return target ? createPortal(children, target) : null;
}

/** A full-window attachment sheet floats above the conversation and its panels. */
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
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const changeOpen = useCallback(
    (next: boolean) => {
      if (!next && content.current) {
        // A dismissal can interrupt entry. Continue from the painted position,
        // rather than jumping to the fully open sheet before sliding down.
        content.current.style.setProperty(
          "--attachment-sheet-exit-transform",
          getComputedStyle(content.current).transform
        );
        const backdrop = content.current.previousElementSibling;
        if (
          backdrop instanceof HTMLElement &&
          backdrop.classList.contains("attachment-stage-backdrop")
        ) {
          backdrop.style.setProperty(
            "--attachment-backdrop-exit-opacity",
            getComputedStyle(backdrop).opacity
          );
        }
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );
  const previousChannel = useRef(channel);
  useLayoutEffect(() => {
    if (open && previousChannel.current !== channel) changeOpen(false);
    previousChannel.current = channel;
  }, [channel, open, changeOpen]);
  const openingControl = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) {
      openingControl.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  }, [open]);
  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent
        ref={content}
        aria-modal="true"
        className="attachment-stage translate-none"
        data-attachment-stage=""
        data-attachment-tone={dark ? "dark" : "default"}
        data-native-platform={window.openteam?.platform}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (openingControl.current?.isConnected) {
            openingControl.current.focus({ preventScroll: true });
          }
        }}
        onPointerDownOutside={(event) => {
          const pointer = event.detail.originalEvent;
          if (pointer.button !== 0 || pointer.ctrlKey) event.preventDefault();
        }}
        overlayClassName="attachment-stage-backdrop"
        showCloseButton={false}
        surface="transparent"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">Preview and download {title}</DialogDescription>
        <header className="attachment-stage-header">
          <ButtonPrimitive
            aria-label={closeLabel}
            className="desktop-elevated-control attachment-stage-close"
            onClick={() => changeOpen(false)}
            title={closeLabel}
            type="button"
          >
            <X className="size-4" strokeWidth={1.8} />
          </ButtonPrimitive>
          <div className="attachment-stage-title" title={title}>
            {title}
          </div>
          <div className="attachment-stage-actions">
            <div className="attachment-preview-tools" ref={setTools} />
            {actions}
          </div>
        </header>
        <PreviewTools.Provider value={tools}>
          <AttachmentStageDismiss.Provider value={() => changeOpen(false)}>
            {children}
          </AttachmentStageDismiss.Provider>
        </PreviewTools.Provider>
        <AttachmentComposer channelId={channel} dark={dark} />
      </DialogContent>
    </Dialog>
  );
}
