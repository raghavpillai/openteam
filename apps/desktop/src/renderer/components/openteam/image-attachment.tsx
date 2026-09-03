import { withStableOccurrenceKeys } from "@openteam/product-core/messages";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { API_BASE } from "../../client/http";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { cn } from "../../lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "../ui/dialog";

export interface DisplayImage {
  url: string;
  alt?: string;
}

export function ImageAttachment({
  image,
  onOpen,
  onRemove,
  variant = "composer",
}: {
  image: DisplayImage;
  onOpen?: () => void;
  onRemove?: () => void;
  variant?: "composer" | "message" | "message-grid";
}) {
  const [open, setOpen] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ height: number; width: number } | null>(null);
  const label = image.alt?.trim() || "Image";
  const rawSource = image.url.startsWith("/api/")
    ? new URL(image.url, API_BASE).toString()
    : image.url;
  const source = useAuthenticatedResource(rawSource);
  const messageWidth = naturalSize
    ? Math.min(naturalSize.width, 320, (naturalSize.width / naturalSize.height) * 300)
    : 320;
  const messageStyle =
    variant === "message"
      ? {
          aspectRatio: naturalSize ? `${naturalSize.width} / ${naturalSize.height}` : "16 / 9",
          width: `${messageWidth}px`,
        }
      : undefined;
  return (
    <>
      <div
        className={cn(
          "group/image relative shrink-0 overflow-hidden border border-black/10 bg-background dark:border-white/15",
          variant === "composer" && "size-[72px] rounded-[14px]",
          variant === "message" && "inline-flex max-w-[min(66vw,100%)] rounded-[12px]",
          variant === "message-grid" && "aspect-square w-full min-w-0 rounded-[12px]"
        )}
        style={messageStyle}
      >
        <button
          aria-label={`Open ${label}`}
          className={cn(
            "relative block overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "size-full"
          )}
          onClick={() => (onOpen ? onOpen() : setOpen(true))}
          style={{ cursor: "zoom-in" }}
          type="button"
        >
          <img
            alt={label}
            className={cn(
              variant === "message" ? "size-full object-contain" : "size-full object-cover"
            )}
            decoding="async"
            loading={variant === "composer" ? "eager" : "lazy"}
            onContextMenu={(event) => event.stopPropagation()}
            onLoad={(event) => {
              if (variant !== "message") return;
              const { naturalHeight, naturalWidth } = event.currentTarget;
              setNaturalSize((current) =>
                current?.height === naturalHeight && current.width === naturalWidth
                  ? current
                  : { height: naturalHeight, width: naturalWidth }
              );
            }}
            src={source ?? undefined}
          />
        </button>
        {onRemove && (
          <button
            aria-label={`Remove ${label}`}
            className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/85 text-white opacity-0 transition hover:bg-black focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 group-hover/image:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            type="button"
          >
            <X className="size-4" strokeWidth={2.3} />
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

export function MessageImageGallery({ images }: { images: DisplayImage[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

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
  const single = images.length === 1;
  const activeLabel = activeImage?.alt?.trim() || "Image";
  const move = (amount: number) =>
    setActiveIndex((current) =>
      current === null ? null : (current + amount + images.length) % images.length
    );
  const downloadActive = () => {
    if (!activeImage || !activeSource) return;
    const anchor = document.createElement("a");
    anchor.href = activeSource;
    anchor.download = activeLabel;
    anchor.click();
  };
  const keyedImages = withStableOccurrenceKeys(images, (image) =>
    [image.alt ?? "", image.url.length, image.url.slice(0, 32), image.url.slice(-32)].join(":")
  );
  return (
    <>
      <div
        className={cn(
          single
            ? "flex w-fit max-w-full"
            : "grid w-[min(360px,66vw)] max-w-full grid-cols-2 gap-1.5"
        )}
      >
        {keyedImages.map(({ value: image, key }, index) => (
          <ImageAttachment
            image={image}
            key={key}
            onOpen={() => setActiveIndex(index)}
            variant={single ? "message" : "message-grid"}
          />
        ))}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setActiveIndex(null);
        }}
        open={activeImage !== null}
      >
        <DialogContent
          className="w-fit !max-w-none gap-0 overflow-visible rounded-none border-0 bg-transparent p-0 text-white shadow-none"
          overlayClassName="bg-black/90"
          showCloseButton={false}
          surface="transparent"
        >
          <DialogTitle className="sr-only">{activeLabel}</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size media preview of {activeLabel}.
          </DialogDescription>
          {activeImage ? (
            <>
              <button
                aria-label={`Close ${activeLabel}`}
                className="block overflow-hidden rounded-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                onClick={() => setActiveIndex(null)}
                style={{ cursor: "zoom-out" }}
                type="button"
              >
                <img
                  alt={activeLabel}
                  className="block max-h-[calc(100vh-112px)] max-w-[calc(100vw-128px)] bg-white object-contain"
                  decoding="async"
                  onContextMenu={(event) => event.stopPropagation()}
                  src={activeSource ?? undefined}
                />
              </button>
              <div className="fixed right-4 top-4 z-[60] flex items-center gap-1.5">
                <button
                  aria-label={`Download ${activeLabel}`}
                  className="grid size-9 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur transition hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                  onClick={downloadActive}
                  type="button"
                >
                  <Download className="size-[17px]" strokeWidth={1.9} />
                </button>
                <button
                  aria-label={`Close ${activeLabel}`}
                  className="grid size-9 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur transition hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                  onClick={() => setActiveIndex(null)}
                  type="button"
                >
                  <X className="size-[18px]" strokeWidth={1.9} />
                </button>
              </div>
              {images.length > 1 ? (
                <>
                  <button
                    aria-label="Previous media"
                    className="fixed left-4 top-1/2 z-[60] grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur transition hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    onClick={() => move(-1)}
                    type="button"
                  >
                    <ChevronLeft className="size-5" strokeWidth={1.9} />
                  </button>
                  <button
                    aria-label="Next media"
                    className="fixed right-4 top-1/2 z-[60] grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur transition hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    onClick={() => move(1)}
                    type="button"
                  >
                    <ChevronRight className="size-5" strokeWidth={1.9} />
                  </button>
                </>
              ) : null}
              <div
                className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] text-center text-[12px] leading-4 text-white/75"
                data-image-viewer-filename
              >
                <span className="inline-block max-w-[calc(100vw-48px)] truncate rounded-full bg-black/45 px-3 py-1.5 align-bottom backdrop-blur">
                  {activeLabel}
                  {images.length > 1 ? `  ·  ${(activeIndex ?? 0) + 1} / ${images.length}` : ""}
                </span>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
