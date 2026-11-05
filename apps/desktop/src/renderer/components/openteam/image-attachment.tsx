import { Download, X } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_BASE } from "../../client/http";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { cn } from "../../lib/cn";
import { imageRowWidth, planImageRow } from "./attachment-visuals";
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "../ui/dialog";

export interface DisplayImage {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

/**
 * Keeps showing the previous image until its replacement has decoded. A sent
 * image changes from its local staged preview to the uploaded copy, which is
 * fetched with authentication; swapping immediately would blank the frame.
 * Blob URLs are not retained: their owner may already have revoked them.
 */
const useSettledImageSource = (source: string | null) => {
  const [shown, setShown] = useState(source);
  useEffect(() => {
    if (!source || source === shown) return;
    if (!shown || shown.startsWith("blob:")) {
      setShown(source);
      return;
    }
    let cancelled = false;
    const next = new Image();
    next.src = source;
    void next
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setShown(source);
      });
    return () => {
      cancelled = true;
    };
  }, [shown, source]);
  return source === shown || !shown || shown.startsWith("blob:") ? source : shown;
};

export function ImageAttachment({
  image,
  onOpen,
  onRemove,
  variant = "composer",
}: {
  image: DisplayImage;
  onOpen?: () => void;
  onRemove?: () => void;
  variant?: "composer" | "message" | "message-grid" | "tile";
}) {
  const [open, setOpen] = useState(false);
  const label = image.alt?.trim() || "Image";
  const rawSource = image.url.startsWith("/api/")
    ? new URL(image.url, API_BASE).toString()
    : image.url;
  const fetchedSource = useAuthenticatedResource(rawSource);
  const source = useSettledImageSource(fetchedSource);
  // Reserve the frame from attachment metadata before fetching/decoding bytes.
  // Images without dimensions keep the fallback frame even after load, so
  // revisiting a chat or remounting a virtual row cannot change its height.
  const hasDimensions =
    typeof image.width === "number" && Number.isFinite(image.width) && image.width > 0 &&
    typeof image.height === "number" && Number.isFinite(image.height) && image.height > 0;
  const width = hasDimensions ? image.width! : 320;
  const height = hasDimensions ? image.height! : 180;
  const messageWidth = Math.min(width, 320, (width / height) * 300);
  const messageStyle =
    variant === "message"
      ? {
          aspectRatio: `${width} / ${height}`,
          width: `${messageWidth}px`,
        }
      : undefined;
  return (
    <>
      <div
        className={cn(
          "group/image relative shrink-0 overflow-hidden border border-black/10 bg-background dark:border-white/15",
          variant === "composer" && "size-14 rounded-[10px] border-[#1c1c1c1f] dark:border-[#f5f5f51a]",
          variant === "tile" && "size-full rounded-[12px] border-0",
          variant === "message" && "inline-flex max-w-[min(66vw,100%)] rounded-[12px]",
          variant === "message-grid" && "aspect-square w-full min-w-0 rounded-[12px]"
        )}
        style={messageStyle}
      >
        <button
          aria-label={`Open ${label}`}
          className={cn(
            "absolute inset-0 block overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "size-full"
          )}
          onClick={() => (onOpen ? onOpen() : setOpen(true))}
          style={{ cursor: "zoom-in" }}
          type="button"
        >
          {source ? (
            <img
              alt={label}
              className={cn(
                variant === "message" ? "size-full object-contain" : "size-full object-cover"
              )}
              decoding="async"
              loading={variant === "composer" ? "eager" : "lazy"}
              onContextMenu={(event) => event.stopPropagation()}
              src={source}
            />
          ) : null}
        </button>
        {onRemove && (
          <button
            aria-label={`Remove ${label}`}
            className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-[#1c1c1c] text-[#fcfcfc] opacity-0 transition focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 group-hover/image:opacity-100 dark:bg-[#f5f5f5] dark:text-[#121212]"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            type="button"
          >
            <X className="size-3" strokeWidth={2.4} />
          </button>
        )}
      </div>

      {!onOpen ? (
        <Dialog onOpenChange={setOpen} open={open}>
          <DialogContent
            className="w-fit !max-w-none gap-0 overflow-visible rounded-none border-0 bg-transparent p-0 text-white shadow-none"
            overlayClassName="bg-black/90"
            showCloseButton={false}
            surface="transparent"
          >
            <DialogTitle className="sr-only">{label}</DialogTitle>
            <DialogDescription className="sr-only">Full-size preview of {label}.</DialogDescription>
            <button
              aria-label={`Close ${label}`}
              className="block overflow-hidden rounded-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              onClick={() => setOpen(false)}
              style={{ cursor: "zoom-out" }}
              type="button"
            >
              <img
                alt={label}
                className="block max-h-[calc(100vh-112px)] max-w-[calc(100vw-64px)] bg-white object-contain"
                decoding="async"
                onContextMenu={(event) => event.stopPropagation()}
                src={source ?? undefined}
              />
            </button>
          </DialogContent>
          {open && (
            <DialogPortal>
              <div
                className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] text-center text-[12px] leading-4 text-white/75"
                data-image-viewer-filename
              >
                <span className="inline-block max-w-[calc(100vw-48px)] truncate px-2 align-bottom">
                  {label}
                </span>
              </div>
            </DialogPortal>
          )}
        </Dialog>
      ) : null}
    </>
  );
}

function MediaThumbnail({ image, index, total, active, onSelect }: {
  image: DisplayImage; index: number; total: number; active: boolean; onSelect: () => void;
}) {
  const raw = image.url.startsWith("/api/") ? new URL(image.url, API_BASE).toString() : image.url;
  const source = useAuthenticatedResource(raw);
  return (
    <button
      aria-current={active || undefined}
      aria-label={`View media ${index + 1} of ${total}`}
      className={cn(
        "grid size-12 shrink-0 place-items-center overflow-hidden rounded-[8px] focus-visible:outline-none",
        active ? "border-2 border-[#f5f5f5]" : "border border-[#f5f5f51a] opacity-50 hover:opacity-80"
      )}
      onClick={onSelect}
      type="button"
    >
      {source ? (
        <img alt="" className={cn("object-cover", active ? "size-10 rounded-[4px]" : "size-[46px] rounded-[7.5px]")} src={source} />
      ) : null}
    </button>
  );
}

/** The chat column a message sits in: the message body row spans it at full width. */
const useChatColumnWidth = (ref: RefObject<HTMLElement | null>) => {
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const column = ref.current?.closest<HTMLElement>(".group-message-body") ?? ref.current?.parentElement;
    if (!column) return;
    const measure = () => setWidth(column.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [ref]);
  return width;
};

export function MessageImageGallery({ images }: { images: DisplayImage[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const columnWidth = useChatColumnWidth(rowRef);

  useEffect(() => {
    if (activeIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && images.length > 1) {
        setActiveIndex((current) =>
          current === null ? null : (current - 1 + images.length) % images.length
        );
      }
      if (event.key === "ArrowRight" && images.length > 1) {
        setActiveIndex((current) => (current === null ? null : (current + 1) % images.length));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, images.length]);

  const activeImage = activeIndex === null ? null : images[activeIndex];
  const activeRawSource = activeImage
    ? activeImage.url.startsWith("/api/")
      ? new URL(activeImage.url, API_BASE).toString()
      : activeImage.url
    : null;
  const activeSource = useAuthenticatedResource(activeRawSource);
  if (images.length === 0) return null;
  const activeLabel = activeImage?.alt?.trim() || "Image";
  const downloadActive = () => {
    if (!activeImage || !activeSource) return;
    const anchor = document.createElement("a");
    anchor.href = activeSource;
    anchor.download = activeLabel;
    anchor.click();
  };
  // Images keep their position in a message. Keying by position keeps a sent
  // image mounted when its staged preview URL becomes the uploaded asset URL.
  const keyedImages = images.map((value, index) => ({ value, key: `image-${index}` }));
  const plan = planImageRow(images, imageRowWidth(columnWidth));
  return (
    <>
      <div className="flex max-w-full gap-1.5" data-image-row="" ref={rowRef}>
        {plan.widths.map((width, index) => {
          const { value: image, key } = keyedImages[index]!;
          const folded = plan.foldedCount > 0 && index === plan.widths.length - 1;
          return (
            <div
              className="relative shrink-0 overflow-hidden rounded-[12px]"
              data-image-tile=""
              key={key}
              style={{ width, height: plan.height }}
            >
              <ImageAttachment image={image} onOpen={() => setActiveIndex(index)} variant="tile" />
              {folded ? (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-[22px] font-semibold text-white/[0.96]">
                  +{plan.foldedCount}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setActiveIndex(null);
        }}
        open={activeImage !== null}
      >
        <DialogContent
          className="inset-0 block h-screen w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0 text-white shadow-none"
          overlayClassName="bg-black/95"
          showCloseButton={false}
          surface="transparent"
        >
          <DialogTitle className="sr-only">{activeLabel}</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size media preview of {activeLabel}.
          </DialogDescription>
          {activeImage ? (
            <div className="flex size-full flex-col items-center" data-media-viewer="">
              <div className="flex min-h-0 w-full flex-1 items-center justify-center px-8 pt-11">
                <img
                  alt={activeLabel}
                  className="block max-h-full max-w-full rounded-[8px] object-contain"
                  decoding="async"
                  onContextMenu={(event) => event.stopPropagation()}
                  src={activeSource ?? undefined}
                />
              </div>
              <span
                className="mt-4 flex h-8 max-w-[calc(100vw-48px)] items-start truncate text-[12px] leading-4 text-[#f5f5f58a]"
                data-image-viewer-filename=""
              >
                {activeLabel}
                {images.length > 1 ? ` · ${(activeIndex ?? 0) + 1} / ${images.length}` : ""}
              </span>
              {images.length > 1 ? (
                <div className="mb-5 flex max-w-[calc(100vw-64px)] gap-2 overflow-x-auto [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent)]" data-media-filmstrip="">
                  {images.map((image, index) => (
                    <MediaThumbnail
                      active={index === activeIndex}
                      image={image}
                      index={index}
                      key={`thumb-${index}`}
                      onSelect={() => setActiveIndex(index)}
                      total={images.length}
                    />
                  ))}
                </div>
              ) : (
                <div className="mb-5 h-12" />
              )}
              <div className="absolute right-3 top-3 flex items-center gap-2">
                <button
                  aria-label="Download media"
                  className="grid size-8 place-items-center rounded-full border border-[#f5f5f50f] bg-[#f5f5f50a] text-[#f5f5f5a8] transition hover:text-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                  onClick={downloadActive}
                  type="button"
                >
                  <Download className="size-4" strokeWidth={1.8} />
                </button>
                <button
                  aria-label="Close media preview"
                  className="grid size-8 place-items-center rounded-full border border-[#f5f5f50f] bg-[#f5f5f50a] text-[#f5f5f5a8] transition hover:text-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                  onClick={() => setActiveIndex(null)}
                  type="button"
                >
                  <X className="size-4" strokeWidth={1.8} />
                </button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
