import { ButtonPrimitive } from "../ui/button-primitive";
import { Download, ImageOff, X } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_BASE } from "../../client/http";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { useResourceActive } from "../../hooks/resource-activity";
import { cn } from "../../lib/cn";
import { LoadingOrb } from "../ui/loading-orb";
import { AttachmentStage } from "./attachment-stage";
import { imageRowWidth, planImageRow } from "./attachment-visuals";

export interface DisplayImage {
  url: string;
  fileName?: string;
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
  return !source || source === shown || !shown || shown.startsWith("blob:") ? source : shown;
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
  const resourcesActive = useResourceActive();
  const label = image.alt?.trim() || "Image";
  const rawSource = image.url.startsWith("/api/")
    ? new URL(image.url, API_BASE).toString()
    : image.url;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const fetchedSource = useAuthenticatedResource(rawSource, {
    enabled: resourcesActive,
    onError: () => setFailedImage(rawSource),
  });
  const source = useSettledImageSource(fetchedSource);
  // Reserve the frame from attachment metadata before fetching/decoding bytes.
  // Images without dimensions keep the fallback frame even after load, so
  // revisiting a chat or remounting a virtual row cannot change its height.
  const hasDimensions =
    typeof image.width === "number" &&
    Number.isFinite(image.width) &&
    image.width > 0 &&
    typeof image.height === "number" &&
    Number.isFinite(image.height) &&
    image.height > 0;
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
          variant === "composer" &&
            "size-14 rounded-[10px] border-[#1c1c1c1f] dark:border-[#f5f5f51a]",
          variant === "tile" && "size-full rounded-[12px] border-0",
          variant === "message" && "inline-flex max-w-[min(66vw,100%)] rounded-[12px]",
          variant === "message-grid" && "aspect-square w-full min-w-0 rounded-[12px]"
        )}
        style={messageStyle}
      >
        <ButtonPrimitive
          aria-label={`Open ${label}`}
          className={cn(
            "absolute inset-0 block overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "size-full"
          )}
          onClick={() => (onOpen ? onOpen() : setOpen(true))}
          style={{ cursor: "zoom-in" }}
          type="button"
        >
          {source && failedImage !== rawSource ? (
            <img
              onError={() => setFailedImage(rawSource)}
              alt={label}
              className={cn(
                variant === "message" ? "size-full object-contain" : "size-full object-cover"
              )}
              decoding="async"
              loading={variant === "composer" ? "eager" : "lazy"}
              onContextMenu={(event) => event.stopPropagation()}
              src={source}
            />
          ) : failedImage === rawSource ? (
            <span
              aria-label={`Image unavailable: ${label}`}
              className="grid size-full place-items-center text-foreground-secondary"
              role="img"
            >
              <ImageOff className="size-5" />
            </span>
          ) : null}
        </ButtonPrimitive>
        {onRemove && (
          <ButtonPrimitive
            aria-label={`Remove ${label}`}
            className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-[#1c1c1c] text-[#fcfcfc] opacity-0 transition focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 group-hover/image:opacity-100 dark:bg-[#f5f5f5] dark:text-[#121212]"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            type="button"
          >
            <X className="size-3" strokeWidth={2.4} />
          </ButtonPrimitive>
        )}
      </div>

      {!onOpen && (
        <ImageAttachmentPreview
          images={[image]}
          activeIndex={open ? 0 : null}
          onActiveIndexChange={(index) =>
            setOpen((typeof index === "function" ? index(open ? 0 : null) : index) !== null)
          }
        />
      )}
    </>
  );
}

function MediaThumbnail({
  image,
  index,
  total,
  active,
  onSelect,
}: {
  image: DisplayImage;
  index: number;
  total: number;
  active: boolean;
  onSelect: () => void;
}) {
  const thumbnail = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active)
      thumbnail.current?.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }, [active]);
  const [visible, setVisible] = useState(active);
  useEffect(() => {
    const element = thumbnail.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      {
        root: element.closest("[data-media-filmstrip]"),
        rootMargin: "0px 56px",
      }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const resourcesActive = useResourceActive();
  const raw = image.url.startsWith("/api/") ? new URL(image.url, API_BASE).toString() : image.url;
  const source = useAuthenticatedResource(raw, { enabled: resourcesActive && (visible || active) });
  return (
    <ButtonPrimitive
      ref={thumbnail}
      aria-current={active || undefined}
      aria-label={`View media ${index + 1} of ${total}`}
      className={cn(
        "grid size-12 shrink-0 place-items-center overflow-hidden rounded-[8px] focus-visible:outline-none",
        active
          ? "border-2 border-[#f5f5f5]"
          : "border border-[#f5f5f51a] opacity-50 hover:opacity-80"
      )}
      onClick={onSelect}
      type="button"
    >
      {source ? (
        <img
          alt=""
          className={cn(
            "object-cover",
            active ? "size-10 rounded-[4px]" : "size-[46px] rounded-[7.5px]"
          )}
          src={source}
        />
      ) : null}
    </ButtonPrimitive>
  );
}

/** The chat column a message sits in: the message body row spans it at full width. */
const useChatColumnWidth = (ref: RefObject<HTMLElement | null>) => {
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const column =
      ref.current?.closest<HTMLElement>(".group-message-body") ?? ref.current?.parentElement;
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
  if (images.length === 0) return null;
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

      <ImageAttachmentPreview
        images={images}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
      />
    </>
  );
}

export function ImageAttachmentPreview({
  images,
  activeIndex,
  onActiveIndexChange,
  title,
}: {
  images: DisplayImage[];
  activeIndex: number | null;
  title?: string;
  onActiveIndexChange: (next: number | null | ((current: number | null) => number | null)) => void;
}) {
  const [filmstrip, setFilmstrip] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!filmstrip) return;
    const update = () => {
      const start = String(filmstrip.scrollLeft > 1);
      const end = String(filmstrip.scrollLeft + filmstrip.clientWidth < filmstrip.scrollWidth - 1);
      if (filmstrip.dataset.overflowStart !== start) filmstrip.dataset.overflowStart = start;
      if (filmstrip.dataset.overflowEnd !== end) filmstrip.dataset.overflowEnd = end;
    };
    update();
    filmstrip.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(filmstrip);
    return () => {
      filmstrip.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [filmstrip, images.length]);
  const resourcesActive = useResourceActive();

  useEffect(() => {
    if (activeIndex === null || !images[activeIndex]) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
        return;
      if (event.key === "ArrowLeft" && images.length > 1) {
        onActiveIndexChange((current) =>
          current === null ? null : (current - 1 + images.length) % images.length
        );
      }
      if (event.key === "ArrowRight" && images.length > 1) {
        onActiveIndexChange((current) => (current === null ? null : (current + 1) % images.length));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, images.length]);

  const activeImage = activeIndex === null ? null : (images[activeIndex] ?? null);
  const activeRawSource = activeImage
    ? activeImage.url.startsWith("/api/")
      ? new URL(activeImage.url, API_BASE).toString()
      : activeImage.url
    : null;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const activeSource = useAuthenticatedResource(activeRawSource, {
    enabled: resourcesActive,
    onError: () => setFailedImage(activeRawSource),
  });
  const activeLabel = title || activeImage?.alt?.trim() || "Image";
  const downloadActive = () => {
    if (!activeImage || !activeSource) return;
    const anchor = document.createElement("a");
    anchor.href = activeSource;
    anchor.download = activeImage.fileName || activeLabel;
    anchor.click();
  };
  return (
    <AttachmentStage
      closeLabel="Close media preview"
      dark
      onOpenChange={(open) => {
        if (!open) onActiveIndexChange(null);
      }}
      open={activeImage !== null}
      title={activeLabel}
      actions={
        <ButtonPrimitive
          aria-label="Download media"
          className="desktop-elevated-control"
          disabled={!activeSource}
          onClick={downloadActive}
          type="button"
        >
          <Download className="size-4" strokeWidth={1.8} />
        </ButtonPrimitive>
      }
    >
      {activeImage && (
        <div className="media-stage-viewer" data-media-viewer="">
          <div className="media-stage-cell">
            {activeSource && failedImage !== activeRawSource ? (
              <img
                alt={activeImage.alt || activeLabel}
                decoding="async"
                width={activeImage.width}
                height={activeImage.height}
                onError={() => setFailedImage(activeRawSource)}
                onContextMenu={(event) => event.stopPropagation()}
                src={activeSource}
              />
            ) : (
              <div className="media-stage-status" role="status">
                {failedImage === activeRawSource && activeRawSource !== null ? (
                  <>
                    <ImageOff className="size-6" />
                    <span>This image couldn’t be loaded.</span>
                  </>
                ) : (
                  <>
                    <LoadingOrb className="size-5" />
                    <span>Loading image…</span>
                  </>
                )}
              </div>
            )}
          </div>
          <span className="media-stage-caption" data-image-viewer-filename="">
            {activeLabel}
            {images.length > 1 ? ` · ${(activeIndex ?? 0) + 1} / ${images.length}` : ""}
          </span>
          {images.length > 1 && (
            <div className="media-stage-filmstrip" data-media-filmstrip="" ref={setFilmstrip}>
              {images.map((image, index) => (
                <MediaThumbnail
                  active={index === activeIndex}
                  image={image}
                  index={index}
                  key={`thumb-${index}`}
                  onSelect={() => onActiveIndexChange(index)}
                  total={images.length}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </AttachmentStage>
  );
}
