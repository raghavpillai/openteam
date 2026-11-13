import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useAuthenticatedResource } from "../../../hooks/use-authenticated-resource";
import { useResourceActive } from "../../../hooks/resource-activity";
import { presentationImageResource } from "../../../lib/presentation-image";
import { Dialog as Modal } from "radix-ui";
import {
  Clock,
  CornerUpRight,
  ExternalLink,
  Globe,
  Map as MapGlyph,
  MapPin,
  Minus,
  Plus,
  Star,
  X,
} from "lucide-react";
import {
  parsePresentation,
  type Place,
  type PlaceMapBlock,
  type Presentation,
  type RankedMediaBlock,
} from "@openteam/contracts/presentation";
import { MessageResponse } from "../../ai-elements/message";
import { placeMapStyle } from "./map-style";
import {
  carouselSpring,
  frameSpring,
  morphSpring,
  prefersReducedMotion,
  settleSpring,
  snapSpring,
  softSpring,
  trailSpring,
  type Spring,
} from "./motion";
import type { Map as VectorMap, Marker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./presentation.css";

// Formatting matches the iOS client: Apple-style durations, road distances in
// the region's units, and ratings rounded half away from zero.
export const travelTime = (seconds: number) => {
  if (seconds < 60) return "<1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} hr${rest ? ` ${rest} min` : ""}`;
};
const milesRegions = new Set(["US", "GB", "LR", "MM"]);
const usesMiles = () => {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region !== undefined && milesRegions.has(region);
  } catch {
    return false;
  }
};
export const routeDistance = (meters: number) => {
  if (usesMiles())
    return meters < 160
      ? `${Math.max(50, Math.round((meters * 3.28084) / 50) * 50)} ft`
      : `${(meters / 1609.344).toFixed(1)} mi`;
  return meters < 1000 ? `${Math.max(10, Math.round(meters / 10) * 10)} m` : `${(meters / 1000).toFixed(1)} km`;
};
const ratingFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const formatRating = (rating: number) => ratingFormat.format(rating);
export const ratingsLabel = (count?: number) =>
  count ? `${count.toLocaleString()} ${count === 1 ? "Rating" : "Ratings"}` : "Rating";
const modeLabel = { walking: "Walk", driving: "Drive", cycling: "Cycle" };
/** Fullscreen switches to a stacked layout below this width (see presentation.css). */
const compactFullscreen = () => innerWidth <= 650;

type Rect = { left: number; top: number; width: number; height: number };
const relativeRect = (element: Element, container: Element): Rect => {
  const a = element.getBoundingClientRect(),
    b = container.getBoundingClientRect();
  return { left: a.left - b.left, top: a.top - b.top, width: a.width, height: a.height };
};
const box = (rect: Rect, radius: number): Keyframe => ({
  left: `${rect.left}px`,
  top: `${rect.top}px`,
  width: `${rect.width}px`,
  height: `${rect.height}px`,
  borderRadius: `${radius}px`,
});

function ExpandMapIcon() {
  return (
    <svg
      className="place-expand-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3.5H3.5V9M3.5 3.5l6.75 6.75M15 20.5h5.5V15m0 5.5-6.75-6.75" />
    </svg>
  );
}

function MarkerPhoto({ source, fallback }: { source: string; fallback: string }) {
  const image = useAuthenticatedResource(presentationImageResource(source));
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);
  return image && !failed ? <img src={image} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : <span className="place-pin-solid" style={{ display: "grid", placeItems: "center" }}>{fallback || "•"}</span>;
}

function useDarkAppearance() {
  const read = () =>
    document.documentElement.classList.contains("dark") ||
    document.documentElement.dataset.theme === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}
function Thumbnail({
  src,
  name,
  icon,
  className = "",
}: {
  src?: string;
  name: string;
  icon?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [element, setElement] = useState<HTMLImageElement | HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const active = useResourceActive();
  useEffect(() => {
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting === true), { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  useEffect(() => setFailed(false), [src]);
  const image = useAuthenticatedResource(presentationImageResource(src), { enabled: active && visible });
  return image && !failed ? (
    <img
      ref={setElement}
      className={`place-thumbnail ${className}`}
      src={image}
      alt={name}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span ref={setElement} className={`place-thumbnail place-thumbnail-empty ${className}`} aria-label={name}>
      {icon && /\p{Extended_Pictographic}/u.test(icon) ? (
        <span className="place-thumbnail-glyph" aria-hidden>
          {icon}
        </span>
      ) : (
        <MapPin size={22} />
      )}
    </span>
  );
}
function PlaceDetails({ place, hideName = false }: { place: Place; hideName?: boolean }) {
  return (
    <span className="place-copy">
      {!hideName && <span className="place-name">{place.name}</span>}
      <span className="place-meta">
        {place.rating !== undefined && (
          <span className="place-rating">
            <Star size={13} fill="currentColor" aria-hidden />
            {formatRating(place.rating)}
          </span>
        )}
        {/* The provider credits a rating; without one it is only noise (the source link remains). */}
        {place.rating !== undefined && place.provider && <span className="place-provider">{place.provider}</span>}
        {place.category && (
          <span>
            {place.rating !== undefined ? "· " : ""}
            {place.category}
          </span>
        )}
      </span>
      {place.isOpen !== undefined && (
        <span className={place.isOpen ? "place-open" : "place-closed"}>
          {place.isOpen ? "Open" : "Closed"}
        </span>
      )}
    </span>
  );
}
function stopLabel(block: PlaceMapBlock, index: number) {
  if (!block.route) return undefined;
  if (!index) return "Start here";
  const leg = block.route.legs[index - 1];
  return leg ? `${modeLabel[block.route.mode]} ~${travelTime(leg.durationSeconds)}` : undefined;
}

/** The route and place labels, as part of the style so theme diffs keep them. */
function withOverlays(style: StyleSpecification, dark: boolean, points: Place[], block: PlaceMapBlock) {
  // Long names would wrap into tall columns that run under the cards.
  const short = (name: string) => (name.length > 28 ? `${name.slice(0, 27).trimEnd()}…` : name);
  style.sources["place-labels"] = {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: points.map((p) => ({
        type: "Feature",
        properties: { name: short(p.name) },
        geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      })),
    },
  };
  if (block.route) {
    style.sources.itinerary = {
      type: "geojson",
      data: { type: "Feature", properties: {}, geometry: block.route.geometry },
    };
    // Apple's route: a solid blue line with a darker edge, scaled with zoom.
    const width = (low: number, high: number) =>
      ["interpolate", ["linear"], ["zoom"], 12, low, 17, high] as unknown as number;
    style.layers.push(
      {
        id: "itinerary-casing",
        type: "line",
        source: "itinerary",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": dark ? "#0a5cff" : "#004de9", "line-width": width(5, 12) },
      },
      {
        id: "itinerary-line",
        type: "line",
        source: "itinerary",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": dark ? "#2b9bff" : "#0c97fe", "line-width": width(3, 8) },
      }
    );
  }
  // Each label carries an invisible pin-sized icon above its point, so the
  // base map's own labels give way to the pin (Apple never lets a pin cover a
  // label). The name sits under the point, clear of the pin.
  style.layers.push({
    id: "place-labels",
    type: "symbol",
    source: "place-labels",
    layout: {
      "icon-image": "place-pin-space",
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": false,
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 10.5,
      "text-transform": "uppercase",
      "text-letter-spacing": 0.04,
      "text-max-width": 7,
      "text-line-height": 1.15,
      "text-anchor": "top",
      "text-offset": [0, 0.5],
      "text-optional": true,
      "text-padding": 2,
    },
    paint: {
      "text-color": dark ? "#d3d9e3" : "#4f535a",
      "text-halo-color": dark ? "#34445b" : "#fbf8ef",
      "text-halo-width": 1.6,
    },
  });
  return style;
}
/** A transparent 44×56 image: the space a pin occupies, for label collisions. */
const pinSpace = { width: 44, height: 56, data: new Uint8Array(44 * 56 * 4) };
/** A spring as a MapLibre easing function (t in 0…1 of the spring's duration). */
const springEase = (curve: Spring) => (t: number) => curve.at(t);
type Padding = { top: number; bottom: number; left: number; right: number };
const addPadding = (a: Padding, b: Padding): Padding => ({
  top: a.top + b.top,
  bottom: a.bottom + b.bottom,
  left: a.left + b.left,
  right: a.right + b.right,
});

function MapSurface({
  points,
  block,
  selected,
  onSelect,
  onBackground,
  detailOpen,
  inlineFrame,
  fullscreen = false,
}: {
  points: Place[];
  block: PlaceMapBlock;
  selected: string | null;
  onSelect: (id: string) => void;
  onBackground: () => void;
  detailOpen: boolean;
  /** The inline map's on-screen rect, so fullscreen can grow out of it. */
  inlineFrame: () => DOMRect | null;
  fullscreen?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    mapRef = useRef<VectorMap | null>(null),
    markers = useRef<Marker[]>([]);
  const onSelectRef = useRef(onSelect),
    onBackgroundRef = useRef(onBackground);
  onSelectRef.current = onSelect;
  onBackgroundRef.current = onBackground;
  const [error, setError] = useState<string>(),
    [ready, setReady] = useState(false);
  const dark = useDarkAppearance(),
    themeRef = useRef(dark);
  themeRef.current = dark;
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const readyRef = useRef(false);
  const focusedFullscreen = useRef(fullscreen);
  /** Re-centers the selected place in the part of the map the glass leaves visible. */
  const focusRef = useRef<((animate: boolean) => boolean) | null>(null);
  /** Eases the camera to the framing the inline map will show, while the
   * fullscreen frame shrinks onto it (so the swap back has nothing to jump). */
  const toInlineRef = useRef<(() => void) | null>(null);
  const inlineFrameRef = useRef(inlineFrame);
  inlineFrameRef.current = inlineFrame;
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting === true),
      { rootMargin: "200px" }
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    const imageRoots: Root[] = [];
    let map: VectorMap | undefined;
    setError(undefined);
    setReady(false);
    readyRef.current = false;
    import("maplibre-gl")
      .then((lib) => {
        if (disposed || !host.current) return;
        map = new lib.Map({
          container: host.current,
          style: withOverlays(placeMapStyle(themeRef.current), themeRef.current, points, block),
          center: [points[0]!.longitude, points[0]!.latitude],
          zoom: 13.5,
          attributionControl: false,
          cooperativeGestures: !fullscreenRef.current,
          // World copies let places either side of the antimeridian share one frame.
          renderWorldCopies: true,
        });
        mapRef.current = map;
        // Only a map that never loaded is an error; later tile hiccups recover,
        // and requests aborted by a fast teardown aren't failures at all.
        map.on("error", (event) => {
          const failure = (event as { error?: { name?: string } }).error;
          if (failure?.name === "AbortError") return;
          if (!disposed && !readyRef.current)
            setError("The map could not load. You can still view the places below.");
        });
        map.on("styleimagemissing", (event) => {
          if (event.id === "place-pin-space" && !map?.hasImage(event.id)) map?.addImage(event.id, pinSpace);
        });
        map.on("click", (event) => {
          const target = event.originalEvent.target as Element | null;
          if (!target?.closest(".place-pin")) onBackgroundRef.current();
        });
        const bounds = () => {
          const coordinates = [
            ...points.map((p) => [p.longitude, p.latitude]),
            ...(block.route?.geometry.coordinates ?? []),
          ];
          const lngs = coordinates.map((p) => p[0]!);
          const crossing = Math.max(...lngs) - Math.min(...lngs) > 180;
          const result = new lib.LngLatBounds();
          coordinates.forEach((p) =>
            result.extend([crossing && p[0]! < 0 ? p[0]! + 360 : p[0]!, p[1]!])
          );
          return result;
        };
        // Keep every place clear of the floating glass that covers part of the
        // map. Pins stand about 52px tall on their point, so the top needs room,
        // and labels hang below the point, so the bottom does too.
        const inlinePadding = (): Padding =>
          block.carousel !== "hidden"
            ? { top: 76, bottom: 176, left: 55, right: 55 }
            : { top: 76, bottom: 50, left: 60, right: 60 };
        const fullPadding = (): Padding =>
          compactFullscreen()
            ? { top: 110, bottom: Math.round(innerHeight * 0.46) + 40, left: 48, right: 48 }
            : { top: 110, bottom: 90, left: 412, right: 72 };
        const camera = (padding: Padding, full: boolean) =>
          map!.cameraForBounds(bounds(), { padding, maxZoom: points.length === 1 ? 14 : full ? 16.5 : 15 });
        const fit = () => {
          const target = camera(fullscreenRef.current ? fullPadding() : inlinePadding(), fullscreenRef.current);
          if (target) map!.jumpTo(target);
        };
        /** Where the inline map sits inside the (fullscreen-sized) map container. */
        const inlineInset = (): Padding | null => {
          const frame = inlineFrameRef.current(),
            own = host.current?.getBoundingClientRect();
          if (!frame || !own) return null;
          return { top: frame.top - own.top, left: frame.left - own.left, bottom: own.bottom - frame.bottom, right: own.right - frame.right };
        };
        // Grow: start on exactly what the inline map showed, at its on-screen
        // position, then ease to the fullscreen framing with the frame's spring.
        const fromInline = () => {
          const inset = inlineInset();
          const start = inset && camera(addPadding(inset, inlinePadding()), false);
          const end = camera(fullPadding(), true);
          if (start) map!.jumpTo(start);
          if (end)
            map!.easeTo({
              ...end,
              duration: prefersReducedMotion() ? 0 : frameSpring.duration,
              easing: springEase(frameSpring),
            });
        };
        toInlineRef.current = () => {
          const inset = inlineInset();
          const end = inset && camera(addPadding(inset, inlinePadding()), false);
          if (end)
            map!.easeTo({
              ...end,
              duration: prefersReducedMotion() ? 0 : settleSpring.duration,
              easing: springEase(settleSpring),
            });
        };
        map.once("style.load", () => {
          if (!map) return;
          fit();
          map.once("idle", () => {
            if (!disposed) {
              readyRef.current = true;
              setReady(true);
              setError(undefined);
            }
          });
        });
        points.forEach((point, index) => {
          // MapLibre positions the marker element with a transform, so the
          // animated glass face lives on a child element.
          const button = document.createElement("button");
          button.type = "button";
          button.className = "place-pin";
          button.dataset.placeId = point.id;
          button.setAttribute("aria-label", point.name);
          // Apple-style landmark pin: the place photo in a white ring, with a
          // small tail dot. Places without a photo get a solid glyph pin.
          const face = document.createElement("span");
          face.className = "place-pin-face";
          const glyph = point.icon && /\p{Extended_Pictographic}/u.test(point.icon) ? point.icon : "";
          if (point.imageUrl) {
            const root = createRoot(face);
            imageRoots.push(root);
            root.render(<MarkerPhoto source={point.imageUrl} fallback={block.route ? String(index + 1) : glyph} />);
          } else {
            face.classList.add("place-pin-solid");
            face.textContent = block.route ? String(index + 1) : glyph;
            if (!face.textContent) face.classList.add("place-pin-dot");
          }
          button.appendChild(face);
          if (block.route && point.imageUrl) {
            const badge = document.createElement("span");
            badge.className = "place-pin-badge";
            badge.textContent = String(index + 1);
            button.appendChild(badge);
          }
          const tail = document.createElement("span");
          tail.className = "place-pin-tail";
          button.appendChild(tail);
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            onSelectRef.current(point.id);
          });
          markers.current.push(
            // The tail dot marks the place, as with Apple's pins.
            new lib.Marker({ element: button, anchor: "bottom" })
              .setLngLat([point.longitude, point.latitude])
              .addTo(map!)
          );
        });
        // Moving between inline and fullscreen frames the map for the new
        // layout (growing out of the inline view); any other resize keeps the
        // selected place in view instead of refitting.
        let laidOutFullscreen = fullscreenRef.current;
        const observer = new ResizeObserver(() => {
          map?.resize();
          if (laidOutFullscreen !== fullscreenRef.current) {
            laidOutFullscreen = fullscreenRef.current;
            if (laidOutFullscreen) fromInline();
            else fit();
            return;
          }
          if (!focusRef.current?.(false)) fit();
        });
        observer.observe(host.current);
        map.once("remove", () => observer.disconnect());
      })
      .catch(
        () =>
          !disposed &&
          setError("The map renderer is unavailable. The place details remain available.")
      );
    return () => {
      disposed = true;
      for (const root of imageRoots) queueMicrotask(() => root.unmount());
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      try {
        map?.remove();
      } catch {
        // A map torn down before its style loaded can throw on abort.
      }
      mapRef.current = null;
      toInlineRef.current = null;
    };
  }, [points, block, retry, visible]);
  useEffect(() => {
    const handler = mapRef.current?.cooperativeGestures;
    // MapLibre hides its "use ⌘ + scroll" hint 100 ms after a blocked wheel; disabling first
    // removes the hint element and that timer then throws. Wait it out.
    const timer = fullscreen ? setTimeout(() => handler?.disable(), 120) : undefined;
    if (!fullscreen) handler?.enable();
    // Closing: the fullscreen frame is still mounted while it shrinks.
    if (!fullscreen) toInlineRef.current?.();
    return () => clearTimeout(timer);
  }, [fullscreen]);
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.setStyle(withOverlays(placeMapStyle(dark), dark, points, block));
    // Recolor only; the map itself is rebuilt when the places change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);
  useEffect(() => {
    markers.current.forEach((marker) => {
      const element = marker.getElement();
      element.setAttribute("aria-pressed", String(element.dataset.placeId === selected));
    });
    const layoutChanged = focusedFullscreen.current !== fullscreen;
    focusedFullscreen.current = fullscreen;
    focusRef.current = (animate) => {
      const point = points.find((p) => p.id === selected),
        map = mapRef.current;
      if (!point || !map) return false;
      // Put the place's point in the middle of the map the glass leaves visible.
      // Pins stand on their point, so aim a little low to center the pin body.
      const { clientWidth: width, clientHeight: height } = map.getContainer();
      const visible = fullscreen
        ? compactFullscreen()
          ? detailOpen
            ? [0, width, 0, height * 0.4]
            : [0, width, 0, height * 0.54]
          : [366, width, 0, height]
        : detailOpen
          ? [0, width, 0, 104]
          : [0, width, 0, block.carousel !== "hidden" ? height - 140 : height];
      const [left, right, top, bottom] = visible as [number, number, number, number];
      map.easeTo({
        center: [point.longitude, point.latitude],
        offset: [(left + right) / 2 - width / 2, Math.min(bottom - 6, (top + bottom) / 2 + 22) - height / 2],
        duration: animate && !prefersReducedMotion() ? 320 : 0,
        easing: (t) => 1 - Math.pow(1 - t, 3),
      });
      return true;
    };
    // Switching layouts has its own camera move (grow/shrink); don't fight it.
    if (!layoutChanged) focusRef.current(true);
  }, [selected, points, fullscreen, block, ready, detailOpen]);
  return (
    <>
      <div
        className="place-map-surface"
        ref={host}
        data-ready={ready}
        role="region"
        aria-label={block.title ?? "Map of places"}
      />
      {!ready && !error && (
        <div className="place-map-loading" role="status">
          <span className="place-map-loading-pulse" aria-hidden />
          Loading map…
        </div>
      )}
      {error && (
        <div className="place-map-error place-glass" role="status">
          {error}
          <button onClick={() => setRetry((x) => x + 1)}>Retry</button>
        </div>
      )}
      {fullscreen && (
        <div className="place-map-navigation place-glass">
          <button aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
            <Plus size={19} />
          </button>
          <span aria-hidden />
          <button aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
            <Minus size={19} />
          </button>
        </div>
      )}
      <div className="place-map-attribution">
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
          OpenFreeMap
        </a>{" "}
        ·{" "}
        <a href="https://openmaptiles.org" target="_blank" rel="noreferrer">
          © OpenMapTiles
        </a>{" "}
        ·{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          © OpenStreetMap
        </a>
      </div>
    </>
  );
}

type MorphSource = { element: HTMLElement; kind: "card" | "pin" };

/** Directions open in Apple Maps in the route's own mode; every place has coordinates. */
export const directionsUrl = (place: Place, mode?: string) =>
  `https://maps.apple.com/directions?destination=${place.latitude.toFixed(6)},${place.longitude.toFixed(6)}${mode ? `&mode=${mode}` : ""}`;

type SharedFrames = { element: HTMLElement; from: Keyframe; to: Keyframe };

/**
 * The place preview is the tapped card, grown in place: the glass container
 * morphs from the card's rectangle (or out of the pin) while the photo and
 * title fly to their new positions on a slightly softer spring, so the content
 * trails the container like one soft body. Closing reverses the same path.
 */
function PlaceDetailPanel({
  place,
  label,
  mode,
  container,
  source,
  closing,
  onClose,
  onExited,
}: {
  place: Place;
  label?: string;
  mode?: "walking" | "driving" | "cycling";
  container: HTMLElement;
  source: () => MorphSource | null;
  closing: boolean;
  onClose: () => void;
  onExited: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null),
    inner = useRef<HTMLDivElement>(null),
    hero = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLDivElement>(null),
    closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const lastHeight = useRef(0),
    shownPlace = useRef(place.id);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  // Repeated clicks on a card land on the panel growing out of it; they must not close it.
  const mountedAt = useRef(performance.now());
  const closeFromPointer = (event: React.MouseEvent) => {
    // Keyboard activation (detail 0) always closes.
    if (event.detail === 0 || performance.now() - mountedAt.current >= 350) onClose();
  };
  // A panel unmounted mid-close (e.g. fullscreen opened) must not finish later
  // and close whichever preview is open by then.
  const unmounted = useRef(false);
  useLayoutEffect(
    () => () => {
      unmounted.current = true;
      panel.current?.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    },
    []
  );
  const subtitle = [label, place.category].filter(Boolean).join(" · ");
  const stats = [
    place.isOpen !== undefined && {
      label: "Hours",
      value: place.isOpen ? "Open" : "Closed",
      tone: place.isOpen ? "place-open" : "place-closed",
    },
    place.rating !== undefined && {
      label: place.reviewCount
        ? `${place.provider ? `${place.provider} · ` : ""}${ratingsLabel(place.reviewCount)}`
        : (place.provider ?? "Rating"),
      value: (
        <>
          <Star size={17} fill="currentColor" aria-hidden />
          <span>{formatRating(place.rating)}</span>
        </>
      ),
      tone: "place-stat-rating",
    },
  ].filter(Boolean) as { label: string; value: ReactNode; tone: string }[];

  /** Frames that carry the card's photo and name onto the preview's. */
  const shared = (card: HTMLElement, panelRect: Rect, originRect: Rect): SharedFrames[] => {
    const frames: SharedFrames[] = [];
    const thumb = card.querySelector(".place-thumbnail"),
      photo = hero.current;
    if (thumb && photo) {
      // The square thumbnail becomes the wide photo: scale to the thumbnail's
      // height and clip the sides, so the image never stretches.
      const t = relativeRect(photo, container),
        f = relativeRect(thumb, container);
      const k = f.height / t.height;
      const inset = Math.max(0, (t.width - f.width / k) / 2);
      const radius = parseFloat(getComputedStyle(thumb).borderTopLeftRadius) || 15;
      frames.push({
        element: photo,
        from: {
          transform: `translate(${f.left - originRect.left - (t.left - panelRect.left) - k * inset}px, ${f.top - originRect.top - (t.top - panelRect.top)}px) scale(${k})`,
          clipPath: `inset(0 ${inset}px round ${radius / k}px)`,
        },
        to: { transform: "none", clipPath: "inset(0 0 round 16px)" },
      });
    }
    const name = card.querySelector(".place-name"),
      title = heading.current?.querySelector("h2");
    if (name && title && heading.current) {
      // Land the title on the card's name, scaled by type size.
      const t = relativeRect(title, container),
        f = relativeRect(name, container);
      const k = parseFloat(getComputedStyle(name).fontSize) / parseFloat(getComputedStyle(title).fontSize);
      frames.push({
        element: heading.current,
        from: {
          transform: `translate(${f.left - originRect.left - (t.left - panelRect.left)}px, ${f.top - originRect.top - (t.top - panelRect.top)}px) scale(${k})`,
        },
        to: { transform: "none" },
      });
    }
    return frames;
  };
  const staggered = () => [...(panel.current?.querySelectorAll("[data-stagger]") ?? [])];

  useLayoutEffect(() => {
    const p = panel.current!,
      content = inner.current!;
    const origin = source();
    const final = relativeRect(p, container);
    const reduced = prefersReducedMotion();
    if (!origin || reduced) {
      p.animate([{ opacity: 0, transform: "translateY(10px) scale(0.98)" }, { opacity: 1, transform: "none" }], {
        duration: reduced ? 1 : softSpring.duration,
        easing: softSpring.easing,
      });
    } else {
      const from = relativeRect(origin.element, container);
      const radius = origin.kind === "pin" ? from.height / 2 : 22;
      const frames = origin.kind === "card" ? shared(origin.element, final, from) : [];
      p.dataset.morphing = "true";
      content.style.width = `${final.width}px`;
      // The box moves without overshoot, so no edge ever passes its container;
      // the goo is a small scale bump on the surface, anchored at the source.
      const growth = p.animate([box(from, radius), box(final, 26)], {
        duration: frameSpring.duration,
        easing: frameSpring.easing,
      });
      const originX = from.left + from.width / 2 - final.left,
        originY = from.top + from.height / 2 - final.top;
      p.animate([{ scale: "0.985" }, { scale: "1" }], {
        duration: morphSpring.duration,
        easing: morphSpring.easing,
      });
      p.style.transformOrigin = `${originX}px ${originY}px`;
      if (origin.kind === "pin")
        p.animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1 }], {
          duration: frameSpring.duration,
        });
      frames.forEach(({ element, from, to }) =>
        element.animate([from, to], { duration: trailSpring.duration, easing: trailSpring.easing })
      );
      // The card has no subtitle; it fades in as the title lands.
      p.querySelector(".place-detail-subtitle")?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 160,
        delay: 90,
        easing: "ease-out",
        fill: "backwards",
      });
      for (const element of [hero.current, heading.current])
        if (element && !frames.some((frame) => frame.element === element))
          element.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
            duration: softSpring.duration,
            delay: 30,
            easing: softSpring.easing,
            fill: "backwards",
          });
      growth.finished
        .then(() => {
          delete p.dataset.morphing;
          content.style.width = "";
          p.style.transformOrigin = "";
          // The panel's settled size, so the first place switch can spring from it.
          lastHeight.current = p.offsetHeight;
        })
        .catch(() => undefined);
    }
    staggered().forEach((item, index) =>
      item.animate(
        [
          { opacity: 0, transform: "translateY(10px)", filter: "blur(4px)" },
          { opacity: 1, transform: "none", filter: "blur(0)" },
        ],
        {
          duration: reduced ? 1 : softSpring.duration,
          delay: reduced ? 0 : 30 + index * 18,
          easing: softSpring.easing,
          fill: "backwards",
        }
      )
    );
    closeButton.current?.focus({ preventScroll: true });
    // Mount-only: later place changes and closing have their own transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching places while open crossfades the content and springs the height.
  useLayoutEffect(() => {
    const p = panel.current!;
    if (shownPlace.current !== place.id && !closing) {
      shownPlace.current = place.id;
      const to = p.offsetHeight;
      if (!prefersReducedMotion() && !p.dataset.morphing) {
        if (lastHeight.current && lastHeight.current !== to)
          p.animate([{ height: `${lastHeight.current}px` }, { height: `${to}px` }], {
            duration: frameSpring.duration,
            easing: frameSpring.easing,
          });
        // Never blank: the new place starts most of the way in.
        inner.current?.animate(
          [
            { opacity: 0.35, transform: "translateY(6px)", filter: "blur(3px)" },
            { opacity: 1, transform: "none", filter: "blur(0)" },
          ],
          { duration: snapSpring.duration, easing: snapSpring.easing }
        );
      }
      inner.current?.scrollTo({ top: 0 });
    }
    // Mid-morph heights are animation frames, not the panel's size.
    if (!p.dataset.morphing) lastHeight.current = p.offsetHeight;
  });

  useLayoutEffect(() => {
    if (!closing) return;
    const p = panel.current!,
      content = inner.current!;
    // Where the panel is drawn right now (mid-open if Escape came early) is
    // where the close starts; the photo and title are measured in the panel's
    // settled layout, after the open is cancelled, so their frames line up.
    const current = relativeRect(p, container);
    p.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    p.style.transformOrigin = "";
    const layout = relativeRect(p, container);
    const origin = source();
    const done = () => {
      if (!unmounted.current) onExitedRef.current();
    };
    if (!origin || prefersReducedMotion()) {
      p.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(10px) scale(0.98)" }], {
        duration: prefersReducedMotion() ? 1 : 150,
        easing: "ease-in",
        fill: "forwards",
      }).finished.then(done, done);
      return;
    }
    content.scrollTo({ top: 0 });
    const to = relativeRect(origin.element, container);
    const frames = origin.kind === "card" ? shared(origin.element, layout, to) : [];
    p.dataset.morphing = "true";
    content.style.width = `${current.width}px`;
    [...staggered(), closeButton.current].forEach((item) =>
      item?.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(6px)", filter: "blur(4px)" }], {
        duration: 100,
        easing: "ease-in",
        fill: "forwards",
      })
    );
    frames.forEach(({ element, from, to: rest }) =>
      element.animate([rest, from], {
        duration: settleSpring.duration,
        easing: settleSpring.easing,
        fill: "forwards",
      })
    );
    for (const element of [hero.current, heading.current])
      if (element && !frames.some((frame) => frame.element === element))
        element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
    const radius = origin.kind === "pin" ? to.height / 2 : 22;
    // Out of a pin the panel shrinks away; onto a card it hands over to the
    // real card, which fades in underneath over the same final stretch.
    p.animate(
      [{ opacity: 1 }, { opacity: 1, offset: origin.kind === "pin" ? 0.6 : 0.7 }, { opacity: 0 }],
      { duration: settleSpring.duration, fill: "forwards" }
    );
    p.animate([box(current, 26), box(to, radius)], {
      duration: settleSpring.duration,
      easing: settleSpring.easing,
      fill: "forwards",
    }).finished.then(done, done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  return (
    <>
      <div className="place-map-scrim" data-closing={closing} aria-hidden />
      <div
        ref={panel}
        className="place-detail place-glass"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-closing={closing}
      >
        {/* First in the DOM so Tab moves from Close into the actions. */}
        <button
          ref={closeButton}
          className="place-detail-close place-glass"
          aria-label="Close place details"
          onClick={closeFromPointer}
        >
          <X size={17} />
        </button>
        <div className="place-detail-inner" ref={inner}>
          <div className="place-detail-heading" ref={heading}>
            <h2 id={titleId}>{place.name}</h2>
            {subtitle && <p className="place-detail-subtitle">{subtitle}</p>}
          </div>
          <div className="place-detail-tiles" data-stagger>
            <a
              className="place-tile place-tile-primary"
              href={directionsUrl(place, mode)}
              target="_blank"
              rel="noreferrer"
            >
              <CornerUpRight size={18} strokeWidth={2.4} aria-hidden />
              <span>Directions</span>
            </a>
            {place.websiteUrl && (
              <a className="place-tile" href={place.websiteUrl} target="_blank" rel="noreferrer">
                <Globe size={18} strokeWidth={2.2} aria-hidden />
                <span>Website</span>
              </a>
            )}
            <button className="place-tile" aria-label="Back to map" onClick={closeFromPointer}>
              <MapGlyph size={18} strokeWidth={2.2} aria-hidden />
              <span>Map</span>
            </button>
          </div>
          {stats.length > 0 && (
            <dl className="place-detail-stats" data-stagger>
              {stats.map((stat) => (
                <div key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd className={stat.tone}>
                    {typeof stat.value === "string" ? <span>{stat.value}</span> : stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {place.imageUrl && (
            <div ref={hero} className="place-detail-photo">
              <Thumbnail src={place.imageUrl} name={place.name} />
            </div>
          )}
          {place.description && (
            <section className="place-detail-section" data-stagger>
              <h3>About</h3>
              <p className="place-detail-box">{place.description}</p>
            </section>
          )}
          {(place.hours || place.address || place.notes) && (
            <section className="place-detail-section" data-stagger>
              <h3>Details</h3>
              <div className="place-detail-box place-detail-facts">
                {place.hours && (
                  <div className="place-detail-row">
                    <Clock size={15} aria-hidden />
                    <div>
                      <span>Hours</span>
                      {place.hours}
                    </div>
                  </div>
                )}
                {place.address && (
                  <div className="place-detail-row">
                    <MapPin size={15} aria-hidden />
                    <div>
                      <span>Address</span>
                      {place.address}
                    </div>
                  </div>
                )}
                {place.notes && (
                  <div className="place-detail-row">
                    <Star size={15} aria-hidden />
                    <div>
                      <span>Note</span>
                      {place.notes}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
          {(place.sourceUrl || place.attribution) && (
            <div className="place-detail-footer" data-stagger>
              {place.sourceUrl && (
                <a className="place-source" href={place.sourceUrl} target="_blank" rel="noreferrer">
                  More on {place.provider ?? "the source"}
                  <ExternalLink size={11} />
                </a>
              )}
              {place.attribution && <span className="place-data-attribution">{place.attribution}</span>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Gives the card lane mass. Mouse drags and flicks carry momentum into the
 * snap, the lane springs onto the nearest card with a slight overshoot and
 * rubber-bands past its ends, and cards lean with velocity (a jelly skew that
 * springs back through the card's transform transition). Trackpad scrolling
 * stays native, then springs onto the nearest card when it settles.
 */
/** iOS's rubber band: the visible stretch grows ever more slowly with the pull. */
const rubberBand = (pull: number, width: number) =>
  (1 - 1 / ((Math.abs(pull) * 0.55) / width + 1)) * width * Math.sign(pull);

function useWeightedCarousel(lane: RefObject<HTMLDivElement | null>) {
  const motion = useRef({ frame: 0, gliding: false });
  const lean = (velocity: number) =>
    lane.current?.style.setProperty(
      "--lean",
      `${Math.max(-3.5, Math.min(3.5, -velocity / 650)).toFixed(2)}deg`
    );
  const stops = () => {
    const el = lane.current;
    if (!el) return [0];
    const max = el.scrollWidth - el.clientWidth;
    return [...el.children].map((child) =>
      Math.max(0, Math.min(max, (child as HTMLElement).offsetLeft - 16))
    );
  };
  const nearest = (x: number) =>
    stops().reduce((best, stop) => (Math.abs(stop - x) < Math.abs(best - x) ? stop : best));
  const glide = useCallback(
    (target: number, velocity = 0, from?: number) => {
      const el = lane.current;
      if (!el) return;
      const m = motion.current;
      cancelAnimationFrame(m.frame);
      if (prefersReducedMotion()) {
        el.scrollLeft = target;
        el.style.setProperty("--overscroll", "0px");
        lean(0);
        return;
      }
      let position = from ?? el.scrollLeft,
        speed = velocity,
        last = performance.now();
      m.gliding = true;
      const step = (now: number) => {
        const dt = Math.min(1 / 30, (now - last) / 1000);
        last = now;
        const max = el.scrollWidth - el.clientWidth;
        const outside = position < 0 || position > max;
        // Past the ends the spring is damped twice as hard, so a flick into the
        // end doesn't fling far out before coming back.
        speed +=
          (-carouselSpring.stiffness * (position - target) -
            carouselSpring.damping * (outside ? 2 : 1) * speed) *
          dt;
        position += speed * dt;
        el.scrollLeft = position;
        const over = position < 0 ? position : position > max ? position - max : 0;
        // The visible stretch uses the same diminishing rubber band as a drag.
        el.style.setProperty("--overscroll", `${(-rubberBand(over, el.clientWidth)).toFixed(1)}px`);
        lean(speed);
        if (Math.abs(speed) < 6 && Math.abs(position - target) < 0.5) {
          el.scrollLeft = target;
          el.style.setProperty("--overscroll", "0px");
          lean(0);
          m.gliding = false;
          return;
        }
        m.frame = requestAnimationFrame(step);
      };
      m.frame = requestAnimationFrame(step);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lane]
  );
  useEffect(() => {
    const el = lane.current;
    if (!el) return;
    const m = motion.current;
    let drag: { id: number; x: number; scroll: number; lastX: number; lastT: number; v: number; moved: boolean } | null =
      null;
    let suppressClick = false,
      idle = 0,
      lastScroll = el.scrollLeft,
      lastTime = performance.now(),
      velocity = 0;
    // Stopping a glide hands its live position (including any stretch) back
    // to whoever stopped it; nothing is left frozen mid-overshoot.
    const stop = () => {
      const stretch = parseFloat(el.style.getPropertyValue("--overscroll")) || 0;
      cancelAnimationFrame(m.frame);
      m.gliding = false;
      el.style.setProperty("--overscroll", "0px");
      lean(0);
      return el.scrollLeft - stretch;
    };
    const settle = (from = el.scrollLeft) => {
      const target = nearest(from);
      if (Math.abs(target - from) > 0.5) glide(target, 0, from);
    };
    const onScroll = () => {
      if (m.gliding || drag) return;
      const now = performance.now();
      velocity = 0.75 * velocity + 0.25 * (((el.scrollLeft - lastScroll) / Math.max(1, now - lastTime)) * 1000);
      lastScroll = el.scrollLeft;
      lastTime = now;
      lean(velocity);
      clearTimeout(idle);
      idle = window.setTimeout(() => {
        velocity = 0;
        lean(0);
      }, 90);
    };
    const onScrollEnd = () => {
      if (m.gliding || drag) return;
      settle();
    };
    // Only horizontal wheel input takes over the lane; scrolling the chat over
    // it lets the glide finish.
    const onWheel = (event: WheelEvent) => {
      if (m.gliding && Math.abs(event.deltaX) > Math.abs(event.deltaY)) stop();
    };
    let pressedAt: number | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      pressedAt = m.gliding ? stop() : null;
      drag = { id: event.pointerId, x: event.clientX, scroll: el.scrollLeft, lastX: event.clientX, lastT: event.timeStamp, v: 0, moved: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < 5) return;
        drag.moved = true;
        el.setPointerCapture(event.pointerId);
        el.dataset.dragging = "true";
      }
      const max = el.scrollWidth - el.clientWidth;
      const wanted = drag.scroll - dx;
      const position = Math.max(0, Math.min(max, wanted));
      el.scrollLeft = position;
      // Past the ends the lane stretches with iOS's diminishing rubber band.
      el.style.setProperty("--overscroll", `${rubberBand(position - wanted, el.clientWidth).toFixed(1)}px`);
      const dt = Math.max(1, event.timeStamp - drag.lastT);
      drag.v = 0.7 * drag.v + 0.3 * ((-(event.clientX - drag.lastX) / dt) * 1000);
      drag.lastX = event.clientX;
      drag.lastT = event.timeStamp;
      lean(drag.v);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const released = drag;
      drag = null;
      delete el.dataset.dragging;
      // A press that caught a glide but never dragged lets it land on a card.
      if (!released.moved) {
        if (pressedAt !== null) settle(pressedAt);
        pressedAt = null;
        return;
      }
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 60);
      const stretch = parseFloat(el.style.getPropertyValue("--overscroll")) || 0;
      const position = el.scrollLeft - stretch;
      // Project the flick forward, then let the spring carry it onto a card.
      glide(nearest(position + released.v * 0.22), released.v, position);
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", onScrollEnd);
    // Card stops move with the lane's width; re-snap after a resize.
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (drag) return;
        if (m.gliding) settle(stop());
        else settle();
      });
    });
    resize.observe(el);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("lostpointercapture", onPointerUp);
    el.addEventListener("click", onClick, true);
    return () => {
      cancelAnimationFrame(m.frame);
      cancelAnimationFrame(resizeFrame);
      resize.disconnect();
      clearTimeout(idle);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", onScrollEnd);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("lostpointercapture", onPointerUp);
      el.removeEventListener("click", onClick, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, glide]);
  return { glide, stopFor: (node: HTMLElement) => nearest(node.offsetLeft - 16) };
}

/** Order of preview opens across every map, for page-level Escape. */
let previewSequence = 0;

function PlaceMap({ block, places }: { block: PlaceMapBlock; places: Place[] }) {
  const points = useMemo(
    () => block.placeIds.map((id) => places.find((place) => place.id === id)!),
    [block, places]
  );
  const [selected, setSelected] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    [fullscreenFrom, setFullscreenFrom] = useState("0px 0px 0px 0px");
  const inline = useRef<HTMLDivElement>(null);
  const carousel = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const expandButton = useRef<HTMLButtonElement>(null);
  const inlineMount = useRef<HTMLDivElement | null>(null);
  const [mapMount] = useState(() => {
    const node = document.createElement("div");
    node.className = "place-map-renderer";
    return node;
  });
  const mountInline = useCallback(
    (node: HTMLDivElement | null) => {
      inlineMount.current = node;
      if (node && !mapMount.parentElement) node.appendChild(mapMount);
    },
    [mapMount]
  );
  const mountFullscreen = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) node.prepend(mapMount);
      else inlineMount.current?.appendChild(mapMount);
    },
    [mapMount]
  );
  const [detail, setDetail] = useState<{ id: string; via: "card" | "pin" | "row" } | null>(null),
    [closing, setClosing] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const detailPlace = detail ? points.find((point) => point.id === detail.id) : undefined;
  const detailIndex = detail ? points.findIndex((point) => point.id === detail.id) : -1;

  const lane = useWeightedCarousel(carousel);
  const select = (id: string) => {
    setSelected(id);
    const node = cards.current.get(id);
    if (node) lane.glide(lane.stopFor(node));
  };
  /** A click that lands while a preview is closing opens as soon as it has. */
  const pendingOpen = useRef<{ id: string; via: "card" | "pin" | "row" } | null>(null);
  const pinFor = (id: string) =>
    mapMount.querySelector<HTMLElement>(`.place-pin[data-place-id="${CSS.escape(id)}"]`);
  const showPlace = (id: string, via: "card" | "pin" | "row") => {
    if (closing) {
      pendingOpen.current = { id, via };
      return;
    }
    select(id);
    if (detail) {
      // Closing should return focus to the place now shown, not the first one.
      trigger.current = (open ? null : cards.current.get(id)) ?? pinFor(id);
      return setDetail({ id, via: detail.via });
    }
    // Clicking a map marker doesn't focus it, so fall back to the pin itself.
    const active = document.activeElement as HTMLElement | null;
    trigger.current = active && active !== document.body ? active : pinFor(id);
    openedAt.current = ++previewSequence;
    setDetail({ id, via: open && via === "card" ? "pin" : via });
  };
  const openedAt = useRef(0);
  const closeDetail = () => {
    if (detail && !closing) setClosing(true);
  };
  const morphSource = (): MorphSource | null => {
    if (!detail) return null;
    // In fullscreen a place opened from the list grows out of its own row.
    if (open && detail.via === "row") {
      const row = document.querySelector<HTMLElement>(
        `.place-itinerary-place[data-place-id="${CSS.escape(detail.id)}"]`
      );
      if (row) return { element: row, kind: "card" };
    }
    const card = cards.current.get(detail.id),
      lane = carousel.current?.getBoundingClientRect();
    if (detail.via === "card" && card && lane && !open) {
      const rect = card.getBoundingClientRect();
      if (rect.left >= lane.left - 1 && rect.right <= lane.right + 1) return { element: card, kind: "card" };
    }
    const pin = mapMount.querySelector<HTMLElement>(
      `.place-pin[data-place-id="${CSS.escape(detail.id)}"] .place-pin-face`
    );
    return pin ? { element: pin, kind: "pin" } : null;
  };
  const restoreFocus = useRef(false);
  const finishDetail = () => {
    restoreFocus.current = !pendingOpen.current;
    setDetail(null);
    setClosing(false);
  };
  // A click queued during the close opens once the close has fully finished
  // (run from an effect so it sees the settled state, not a stale closure).
  useEffect(() => {
    if (detail || closing || !pendingOpen.current) return;
    const next = pendingOpen.current;
    pendingOpen.current = null;
    showPlace(next.id, next.via);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, closing]);
  // The source card is hidden until the preview unmounts, so focus it afterwards.
  useEffect(() => {
    if (detail || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, [detail]);
  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape belongs to the preview only while focus is in this map, or on
      // the page with this the most recently opened preview; typing in the
      // composer keeps its own Escape.
      const active = document.activeElement;
      const unfocused = !active || active === document.body;
      const here =
        (unfocused && openedAt.current === previewSequence) ||
        inline.current?.contains(active) ||
        mapMount.contains(active) ||
        (open && document.querySelector(".place-fullscreen")?.contains(active));
      if (!here) return;
      // Until the close finishes, repeated Escapes stay with this preview.
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!closing) setClosing(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [detail, closing, open]);

  /** The fullscreen map grows out of, and collapses back into, the inline map. */
  const captureInline = () => {
    const rect = inline.current?.getBoundingClientRect();
    if (!rect) return;
    const gutter = compactFullscreen() ? 0 : 8;
    setFullscreenFrom(
      `${rect.top - gutter}px ${innerWidth - gutter - rect.right}px ${innerHeight - gutter - rect.bottom}px ${rect.left - gutter}px`
    );
  };
  const setFullscreen = (value: boolean) => {
    captureInline();
    // The preview belongs to one layout; it never travels between them.
    pendingOpen.current = null;
    setDetail(null);
    setClosing(false);
    setRevisited(false);
    setOpen(value);
  };
  /** Once a place card has been shown in fullscreen, the list returns by
   * fading (not by re-running its entrance slide). */
  const [revisited, setRevisited] = useState(false);
  useEffect(() => {
    if (open && detail) setRevisited(true);
  }, [open, detail]);

  return (
    <section className="place-map-block">
      {block.title && <h3>{block.title}</h3>}
      <div
        ref={inline}
        className={`place-map-inline ${block.carousel === "hidden" ? "place-map-no-cards" : ""}`}
        data-preview={detail !== null && !closing && !open}
        data-returning={closing}
      >
        <div className="place-map-canvas-host" ref={mountInline} />
        <button
          ref={expandButton}
          className="place-map-expand place-glass"
          onClick={() => setFullscreen(true)}
          aria-label="Open map full screen"
          title="Expand map"
        >
          <ExpandMapIcon />
        </button>
        {block.carousel !== "hidden" && (
          <div
            className="place-map-carousel"
            ref={carousel}
            aria-label="Places"
            // Cards stay clickable while a preview closes (the click opens next).
            inert={detail !== null && !closing && !open}
          >
            {points.map((point, index) => (
              <button
                key={point.id}
                ref={(node) => {
                  if (node) cards.current.set(point.id, node);
                  else cards.current.delete(point.id);
                }}
                className="place-card place-glass"
                aria-pressed={selected === point.id}
                data-source={detail?.id === point.id && !open ? (closing ? "closing" : "true") : "false"}
                style={
                  {
                    "--stagger": `${detailIndex < 0 ? 0 : Math.abs(index - detailIndex) * 28}ms`,
                  } as CSSProperties
                }
                onClick={() => showPlace(point.id, "card")}
                // Keyboard focus brings a part-hidden card fully into view.
                onFocus={(event) => {
                  if (event.currentTarget.matches(":focus-visible"))
                    lane.glide(lane.stopFor(event.currentTarget));
                }}
                aria-label={`View details for ${point.name}`}
              >
                <Thumbnail src={point.imageUrl} name={point.name} icon={point.icon} />
                <span className="place-card-body">
                  {stopLabel(block, index) && (
                    <span className="place-stop-label">{stopLabel(block, index)}</span>
                  )}
                  <PlaceDetails place={point} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <Modal.Root open={open} onOpenChange={setFullscreen}>
        <Modal.Portal>
          <Modal.Overlay className="place-fullscreen-overlay" />
          <Modal.Content
            className="place-fullscreen presentation"
            data-detail={detail !== null && !closing}
            data-revisited={revisited}
            aria-describedby={undefined}
            style={{ "--fullscreen-from": fullscreenFrom } as CSSProperties}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              expandButton.current?.focus({ preventScroll: true });
            }}
          >
            <Modal.Title className="sr-only">{block.title ?? "Places on the map"}</Modal.Title>
            <div className="place-fullscreen-map" ref={mountFullscreen}>
              <Modal.Close className="place-fullscreen-close place-glass" aria-label="Close map">
                <X size={20} />
              </Modal.Close>
            </div>
            {/* A fixed glass shell with a scroller inside: content never paints
                outside the glass, and the rim never scrolls away. */}
            <aside className="place-itinerary place-glass" inert={detail !== null && !closing}>
              <div className="place-itinerary-scroll">
              <header>
                <span className="place-itinerary-eyebrow">
                  {points.length} {points.length === 1 ? "place" : "places"}
                </span>
                <h2>{block.title ?? "Your places"}</h2>
                {block.route && (
                  <div className="place-route-summary">
                    <strong>{travelTime(block.route.durationSeconds)}</strong>
                    <span>
                      {routeDistance(block.route.distanceMeters)} · {modeLabel[block.route.mode]}
                    </span>
                  </div>
                )}
              </header>
              <ol className="place-itinerary-stops">
                {points.map((point, index) => (
                  <li
                    className="place-itinerary-stop"
                    key={point.id}
                    style={{ "--i": index } as CSSProperties}
                  >
                    <span className="place-stop-marker" aria-hidden>
                      {block.route ? index + 1 : ""}
                    </span>
                    <div className="place-stop-content">
                      {block.route && (
                        <p className="place-stop-label">
                          {index === 0
                            ? "Start here"
                            : index === points.length - 1
                              ? "Destination"
                              : `Stop ${index + 1}`}
                        </p>
                      )}
                      <button
                        className="place-itinerary-place"
                        data-place-id={point.id}
                        aria-pressed={selected === point.id}
                        aria-label={`${point.name}${point.rating !== undefined ? `, rated ${formatRating(point.rating)}` : ""}${point.category ? `, ${point.category}` : ""}`}
                        onClick={() => showPlace(point.id, "row")}
                      >
                        <Thumbnail src={point.imageUrl} name={point.name} icon={point.icon} />
                        <PlaceDetails place={point} />
                      </button>
                      {point.notes && <p className="place-stop-note">{point.notes}</p>}
                      {point.address && <p className="place-address">{point.address}</p>}
                      {point.sourceUrl && (
                        <a
                          className="place-source"
                          href={point.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {point.provider ?? "Source"}
                          <ExternalLink size={11} />
                        </a>
                      )}
                      {block.route?.legs[index] && (
                        <div className="place-travel-separator">
                          {modeLabel[block.route.mode]} ~
                          {travelTime(block.route.legs[index]!.durationSeconds)}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {block.route?.attribution && (
                <p className="place-data-attribution">{block.route.attribution}</p>
              )}
              </div>
            </aside>
          </Modal.Content>
        </Modal.Portal>
      </Modal.Root>
      {createPortal(
        <MapSurface
          points={points}
          block={block}
          selected={selected}
          onSelect={(id) => showPlace(id, "pin")}
          onBackground={closeDetail}
          // The map holds still until a closing preview has landed on its pin.
          detailOpen={detail !== null}
          inlineFrame={() => inline.current?.getBoundingClientRect() ?? null}
          fullscreen={open}
        />,
        mapMount
      )}
      {detailPlace &&
        createPortal(
          <PlaceDetailPanel
            place={detailPlace}
            label={stopLabel(block, detailIndex)}
            mode={block.route?.mode}
            container={mapMount}
            source={morphSource}
            closing={closing}
            onClose={closeDetail}
            onExited={finishDetail}
          />,
          mapMount
        )}
    </section>
  );
}
function RankedMediaList({ block, places }: { block: RankedMediaBlock; places: Place[] }) {
  return (
    <section className="ranked-media-list">
      {block.title && <h3>{block.title}</h3>}
      <ol>
        {block.items.map((item, index) => {
          const point = places.find((place) => place.id === item.placeId);
          const image = item.imageUrl ?? point?.imageUrl;
          return (
            <li key={item.id} data-linked={item.href !== undefined}>
              <div className="ranked-media-art">
                <Thumbnail src={image} name={item.title} icon={point?.icon} />
                <span className="ranked-media-rank" aria-hidden data-photo={image !== undefined}>
                  {index + 1}
                </span>
              </div>
              <div className="ranked-media-copy">
                <h4>
                  <span className="sr-only">{index + 1}. </span>
                  {item.href ? (
                    <a className="ranked-media-link" href={item.href} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                  ) : (
                    item.title
                  )}
                </h4>
                {item.description && <p>{item.description}</p>}
                {item.sourceUrl && (
                  <a
                    className="ranked-media-source"
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.sourceLabel ?? "Source"}
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
export function PresentationView({ presentation }: { presentation: Presentation }) {
  return (
    <div className="presentation">
      {presentation.blocks.map((block, index) =>
        block.type === "markdown" ? (
          <div key={index} className="presentation-prose">
            <MessageResponse>{block.text}</MessageResponse>
          </div>
        ) : block.type === "place_map" ? (
          <PlaceMap key={index} block={block} places={presentation.places} />
        ) : (
          <RankedMediaList key={index} block={block} places={presentation.places} />
        )
      )}
    </div>
  );
}
export default function PresentationMessage({
  value,
  fallback,
}: {
  value: unknown;
  fallback: string;
}) {
  const result = useMemo(() => {
    try {
      return parsePresentation(value);
    } catch {
      return null;
    }
  }, [value]);
  return result ? (
    <PresentationView presentation={result} />
  ) : (
    <MessageResponse>{fallback}</MessageResponse>
  );
}
