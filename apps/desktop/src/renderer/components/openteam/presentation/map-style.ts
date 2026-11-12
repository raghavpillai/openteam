import base from "./base-map-style.json";
import type { StyleSpecification } from "maplibre-gl";

/** Apple-inspired day/night palette over OpenFreeMap/OpenMapTiles data.
 * Data attribution stays visible in both inline and full-screen views.
 */
export function placeMapStyle(dark: boolean): StyleSpecification {
  const style = structuredClone(base) as StyleSpecification;
  const greenLayer = style.layers.findIndex((layer) => layer.id === "landcover_wood");
  style.layers.splice(greenLayer < 0 ? 1 : greenLayer, 0, {
    id: "landcover_grass",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landcover",
    filter: ["==", ["get", "class"], "grass"],
    paint: { "fill-color": dark ? "#1d514b" : "#c3e7b1", "fill-opacity": 0.85 },
  });
  for (const layer of style.layers) {
    // Rail yards overwhelm the street network at neighborhood scale.
    if (layer.id.startsWith("railway")) layer.minzoom = 15;
    const paint = (layer as any).paint ?? {};
    if (layer.type === "background") paint["background-color"] = dark ? "#24313d" : "#f6f5f0";
    if (layer.id === "water") paint["fill-color"] = dark ? "#142339" : "#afd9eb";
    if (layer.id === "landuse_residential") paint["fill-color"] = dark ? "#393e56" : "#faf5e5";
    if (layer.id.includes("park") || layer.id.includes("wood"))
      paint["fill-color"] = dark ? "#1d514b" : "#c3e7b1";
    if (
      ["road_area_pier", "aeroway-area", "landcover_ice_shelf", "landcover_glacier"].includes(
        layer.id
      )
    )
      paint["fill-color"] = dark ? "#293a45" : "#f4f3ee";
    if (layer.id === "building") {
      paint["fill-color"] = dark ? "#344955" : "#e9e7df";
      paint["fill-outline-color"] = dark ? "#3a4d59" : "#e0e0d7";
    }
    if (layer.type === "line") {
      paint["line-color"] = layer.id.includes("highway")
        ? layer.id.includes("casing")
          ? dark
            ? "#344452"
            : "#a7b2b0"
          : dark
            ? "#657b8e"
            : "#cbd2d1"
        : dark
          ? "#425a6b"
          : "#c8d2d2";
    }
    if (layer.type === "symbol") {
      paint["text-color"] = dark ? "#c2cad3" : "#65716c";
      paint["text-halo-color"] = dark ? "#273442" : "#fdfcf7";
      paint["text-halo-width"] = 1.5;
    }
  }
  style.layers.push({
    id: "transit-station-names",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom: 12,
    filter: ["all", ["==", ["get", "class"], "railway"], ["==", ["get", "subclass"], "station"]],
    layout: {
      "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
      "text-max-width": 12,
      "text-padding": 6,
    },
    paint: {
      "text-color": dark ? "#84a9ff" : "#4167d9",
      "text-halo-color": dark ? "#242737" : "#ffffff",
      "text-halo-width": 1.8,
    },
  });
  return style;
}
