import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog as Modal } from "radix-ui";
import { MapPin, Minus, Plus, Star, X, ExternalLink, ArrowUpRight } from "lucide-react";
import {
  parsePresentation,
  type Place,
  type PlaceMapBlock,
  type Presentation,
  type RankedMediaBlock,
} from "@openteam/contracts/presentation";
import { MessageResponse } from "../../ai-elements/message";
import { placeMapStyle } from "./map-style";
import type { Map as VectorMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./presentation.css";

export const travelTime = (seconds: number) =>
  seconds < 60 ? "<1 min" : `${Math.round(seconds / 60)} min`;
export const routeDistance = (meters: number) =>
  typeof navigator !== "undefined" && navigator.language === "en-US"
    ? `${(meters / 1609.344).toFixed(1)} mi`
    : `${(meters / 1000).toFixed(1)} km`;
const modeLabel = { walking: "Walk", driving: "Drive", cycling: "Cycle" };

function ExpandMapIcon() {
  return (
    <svg
      className="place-expand-icon"
      width="20"
      height="20"
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
function Thumbnail({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <img
      className="place-thumbnail"
      src={src}
      alt={name}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="place-thumbnail place-thumbnail-empty" aria-label={name}>
      <MapPin size={23} />
    </span>
  );
}
function PlaceDetails({ place, hideName = false }: { place: Place; hideName?: boolean }) {
  return (
    <span className="place-copy">
      {!hideName && <span className="place-name">{place.name}</span>}
      <span className="place-meta">
        {place.rating !== undefined && (
          <>
            <Star size={14} fill="currentColor" aria-hidden />
            {place.rating.toFixed(1)}
          </>
        )}
        {place.provider && <span className="place-provider">{place.provider}</span>}
        {place.category && (
          <span>
            {place.rating !== undefined || place.provider ? "· " : ""}
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

function MapSurface({
  points,
  block,
  selected,
  onSelect,
  fullscreen = false,
}: {
  points: Place[];
  block: PlaceMapBlock;
  selected: string | null;
  onSelect: (id: string) => void;
  fullscreen?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    mapRef = useRef<VectorMap | null>(null),
    markers = useRef<Marker[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [error, setError] = useState<string>(),
    [ready, setReady] = useState(false);
  const dark = useDarkAppearance(),
    themeRef = useRef(dark);
  themeRef.current = dark;
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
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
    let map: VectorMap | undefined;
    setError(undefined);
    setReady(false);
    import("maplibre-gl")
      .then((lib) => {
        if (disposed || !host.current) return;
        map = new lib.Map({
          container: host.current,
          style: placeMapStyle(themeRef.current),
          center: [points[0]!.longitude, points[0]!.latitude],
          zoom: 13.5,
          attributionControl: false,
          cooperativeGestures: !fullscreenRef.current,
          renderWorldCopies: false,
        });
        mapRef.current = map;
        map.on("error", () => {
          if (!disposed) setError("The map could not load. You can still view the places below.");
        });
        const fit = () => {
          if (!map) return;
          const coordinates = [
            ...points.map((p) => [p.longitude, p.latitude]),
            ...(block.route?.geometry.coordinates ?? []),
          ];
          const lngs = coordinates.map((p) => p[0]!);
          const crossing = Math.max(...lngs) - Math.min(...lngs) > 180;
          const bounds = new lib.LngLatBounds();
          coordinates.forEach((p) =>
            bounds.extend([crossing && p[0]! < 0 ? p[0]! + 360 : p[0]!, p[1]!])
          );
          const padding =
            block.carousel !== "hidden" && !fullscreenRef.current
              ? { top: 60, bottom: 125, left: 55, right: 55 }
              : 60;
          if (points.length === 1)
            map.jumpTo({ center: [points[0]!.longitude, points[0]!.latitude], zoom: 14 });
          else map.fitBounds(bounds, { padding, maxZoom: 13.8, duration: 0 });
        };
        map.on("style.load", () => {
          if (!map) return;
          if (block.route) {
            map.addSource("itinerary", {
              type: "geojson",
              data: { type: "Feature", properties: {}, geometry: block.route.geometry },
            });
            map.addLayer({
              id: "itinerary-line",
              type: "line",
              source: "itinerary",
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": themeRef.current ? "#409cff" : "#007aff",
                "line-width": 3.5,
                "line-dasharray": [0.1, 1.8],
              },
            });
          }
          map.addSource("place-labels", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: points.map((p) => ({
                type: "Feature",
                properties: { name: p.name },
                geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
              })),
            },
          });
          map.addLayer({
            id: "place-labels",
            type: "symbol",
            source: "place-labels",
            layout: {
              "text-field": ["get", "name"],
              "text-font": ["Noto Sans Bold"],
              "text-size": 12,
              "text-variable-anchor": ["bottom", "top", "right", "left"],
              "text-radial-offset": 1.6,
              "text-padding": 4,
            },
            paint: {
              "text-color": themeRef.current ? "#f1f1ef" : "#202020",
              "text-halo-color": themeRef.current ? "#2b2e40" : "#fffaf4",
              "text-halo-width": 1.5,
            },
          });
          fit();
          map.once("idle", () => {
            if (!disposed) {
              setReady(true);
              setError(undefined);
            }
          });
        });
        points.forEach((point, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "place-pin";
          button.dataset.placeId = point.id;
          button.setAttribute("aria-label", point.name);
          button.textContent = block.route
            ? String(index + 1)
            : point.icon && /\p{Extended_Pictographic}/u.test(point.icon)
              ? point.icon
              : "●";
          button.addEventListener("click", () => onSelectRef.current(point.id));
          markers.current.push(
            new lib.Marker({ element: button })
              .setLngLat([point.longitude, point.latitude])
              .addTo(map!)
          );
        });
        const observer = new ResizeObserver(() => {
          map?.resize();
          fit();
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
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      map?.remove();
      mapRef.current = null;
    };
  }, [points, block, retry, visible]);
  useEffect(() => {
    const handler = mapRef.current?.cooperativeGestures;
    if (fullscreen) handler?.disable();
    else handler?.enable();
  }, [fullscreen]);
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.setStyle(placeMapStyle(dark));
  }, [dark]);
  useEffect(() => {
    markers.current.forEach((marker) => {
      const element = marker.getElement();
      element.setAttribute("aria-pressed", String(element.dataset.placeId === selected));
    });
    const point = points.find((p) => p.id === selected),
      map = mapRef.current;
    if (point && map)
      map.easeTo({
        center: [point.longitude, point.latitude],
        offset: [0, !fullscreen && block.carousel !== "hidden" ? -40 : 0],
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350,
      });
  }, [selected, points, fullscreen, block, ready]);
  return (
    <>
      <div className="place-map-surface" ref={host} aria-label={block.title ?? "Map of places"} />
      {!ready && !error && (
        <div className="place-map-loading" role="status">
          Loading map…
        </div>
      )}
      {error && (
        <div className="place-map-error" role="status">
          {error}
          <button onClick={() => setRetry((x) => x + 1)}>Retry</button>
        </div>
      )}
      {fullscreen && (
        <div className="place-map-navigation">
          <button aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
            <Plus size={21} />
          </button>
          <button aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
            <Minus size={21} />
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

function PlaceMap({ block, places }: { block: PlaceMapBlock; places: Place[] }) {
  const points = useMemo(
    () => block.placeIds.map((id) => places.find((place) => place.id === id)!),
    [block, places]
  );
  const [selected, setSelected] = useState<string | null>(null),
    [open, setOpen] = useState(false);
  const carousel = useRef<HTMLDivElement>(null);
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
      if (node) node.appendChild(mapMount);
      else inlineMount.current?.appendChild(mapMount);
    },
    [mapMount]
  );
  const [preview, setPreview] = useState<Place | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const select = (id: string) => {
    setSelected(id);
    const index = points.findIndex((p) => p.id === id);
    const node = carousel.current?.children[index] as HTMLElement | undefined;
    if (node && carousel.current)
      carousel.current.scrollTo({
        left: node.offsetLeft - 12,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
  };
  const showPlace = (id: string) => {
    select(id);
    previewTrigger.current = document.activeElement as HTMLElement | null;
    setPreview(points.find((point) => point.id === id) ?? null);
  };
  return (
    <section className="place-map-block">
      {block.title && <h3>{block.title}</h3>}
      <div
        className={`place-map-inline ${block.carousel === "hidden" ? "place-map-no-cards" : ""}`}
      >
        <div className="place-map-canvas-host" ref={mountInline} />
        <button
          ref={expandButton}
          className="place-map-expand"
          onClick={() => setOpen(true)}
          aria-label="Open map full screen"
          title="Expand map"
        >
          <ExpandMapIcon />
        </button>
        {block.carousel !== "hidden" && (
          <div className="place-map-carousel" ref={carousel} aria-label="Places">
            {points.map((point, index) => (
              <button
                key={point.id}
                className="place-card"
                aria-pressed={selected === point.id}
                onClick={() => showPlace(point.id)}
                aria-label={`View details for ${point.name}`}
              >
                <Thumbnail src={point.imageUrl} name={point.name} />
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
      <Modal.Root open={open} onOpenChange={setOpen}>
        <Modal.Portal>
          <Modal.Overlay className="place-fullscreen-overlay" />
          <Modal.Content
            className="place-fullscreen presentation"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              expandButton.current?.focus();
            }}
          >
            <Modal.Title className="sr-only">{block.title ?? "Places on the map"}</Modal.Title>
            <div className="place-fullscreen-map" ref={mountFullscreen}>
              <Modal.Close className="place-fullscreen-close" aria-label="Close map">
                <X size={22} />
              </Modal.Close>
            </div>
            <aside className="place-itinerary">
              <header>
                <span>
                  {points.length} {points.length === 1 ? "place" : "places"}
                </span>
                <h2>{block.title ?? "Your places"}</h2>
                {block.route && (
                  <p>
                    {modeLabel[block.route.mode]} · {routeDistance(block.route.distanceMeters)} ·{" "}
                    {travelTime(block.route.durationSeconds)}
                  </p>
                )}
              </header>
              <div className="place-itinerary-stops">
                {points.map((point, index) => (
                  <div className="place-itinerary-stop" key={point.id}>
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
                      aria-pressed={selected === point.id}
                      onClick={() => showPlace(point.id)}
                    >
                      <Thumbnail src={point.imageUrl} name={point.name} />
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
                        <ExternalLink size={12} />
                      </a>
                    )}
                    {block.route?.legs[index] && (
                      <div className="place-travel-separator">
                        <span />
                        {modeLabel[block.route.mode]} ~
                        {travelTime(block.route.legs[index]!.durationSeconds)}
                        <span />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {block.route?.attribution && (
                <p className="place-data-attribution">{block.route.attribution}</p>
              )}
            </aside>
          </Modal.Content>
        </Modal.Portal>
      </Modal.Root>
      {createPortal(
        <MapSurface
          points={points}
          block={block}
          selected={selected}
          onSelect={showPlace}
          fullscreen={open}
        />,
        mapMount
      )}
      <Modal.Root
        open={preview !== null}
        onOpenChange={(value) => {
          if (!value) setPreview(null);
        }}
      >
        <Modal.Portal>
          <Modal.Overlay className="place-detail-overlay" />
          <Modal.Content
            className="place-detail presentation"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (previewTrigger.current?.isConnected)
                previewTrigger.current.focus({ preventScroll: true });
            }}
          >
            {preview && (
              <>
                <div
                  className={`place-detail-hero${preview.imageUrl ? "" : " place-detail-hero-empty"}`}
                >
                  {preview.imageUrl ? (
                    <img src={preview.imageUrl} alt={preview.name} referrerPolicy="no-referrer" />
                  ) : (
                    <MapPin size={36} />
                  )}
                </div>
                <Modal.Close className="place-detail-close" aria-label="Close place details">
                  <X size={19} />
                </Modal.Close>
                <div className="place-detail-copy">
                  <Modal.Title>{preview.name}</Modal.Title>
                  <PlaceDetails place={preview} hideName />
                  <div className="place-detail-actions">
                    <button
                      onClick={() => {
                        setPreview(null);
                        setOpen(true);
                      }}
                    >
                      Show on map
                      <ArrowUpRight size={15} />
                    </button>
                    {preview.websiteUrl && (
                      <a href={preview.websiteUrl} target="_blank" rel="noreferrer">
                        Website
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                  {preview.description && (
                    <p className="place-detail-description">{preview.description}</p>
                  )}
                  {preview.hours && <p className="place-detail-row">{preview.hours}</p>}
                  {preview.address && (
                    <p className="place-detail-row">
                      <MapPin size={17} />
                      {preview.address}
                    </p>
                  )}
                  {preview.notes && <p className="place-stop-note">{preview.notes}</p>}
                  {preview.sourceUrl && (
                    <a
                      className="place-source"
                      href={preview.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {preview.provider ?? "Source"}
                      <ExternalLink size={12} />
                    </a>
                  )}
                  {preview.attribution && (
                    <p className="place-data-attribution">{preview.attribution}</p>
                  )}
                </div>
              </>
            )}
          </Modal.Content>
        </Modal.Portal>
      </Modal.Root>
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
            <li key={item.id}>
              <Thumbnail src={image} name={item.title} />
              <div>
                <h4>
                  {item.href ? (
                    <a href={item.href} target="_blank" rel="noreferrer">
                      {index + 1}. {item.title}
                    </a>
                  ) : (
                    `${index + 1}. ${item.title}`
                  )}
                </h4>
                {item.description && <p>{item.description}</p>}
                {item.sourceUrl && (
                  <a
                    className="place-source"
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.sourceLabel ?? "Source"}
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
