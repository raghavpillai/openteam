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
    paint: { "fill-color": dark ? "#005d5b" : "#c9e9ac", "fill-opacity": 0.9 },
  });
  // Colors sampled from Apple Maps (maps.apple.com, standard map) over Midtown.
  const line: Record<string, [string, string]> = {
    highway_path: ["#f0ece0", "#44546b"],
    highway_minor: ["#fdfdfd", "#5b6c83"],
    highway_major_casing: ["#dcdee1", "#54647b"],
    highway_major_inner: ["#ffffff", "#7a8ba1"],
    highway_major_subtle: ["#e6e7e8", "#5b6c83"],
    highway_motorway_casing: ["#b3b5b9", "#44546b"],
    highway_motorway_inner: ["#ced1d4", "#7a8dab"],
    highway_motorway_subtle: ["#d6d8da", "#5b6c83"],
  };
  // Apple tints built-up city blocks, not only residential ones.
  const residential = style.layers.findIndex((layer) => layer.id === "landuse_residential");
  style.layers.splice(residential + 1, 0, {
    id: "landuse_urban",
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landuse",
    filter: [
      "match",
      ["get", "class"],
      ["commercial", "retail", "industrial", "neighbourhood", "quarter", "suburb", "school", "university", "hospital"],
      true,
      false,
    ],
    paint: { "fill-color": dark ? "#44486d" : "#fef5e0", "fill-opacity": 1 },
  });
  for (const layer of style.layers) {
    // Rail yards overwhelm the street network at neighborhood scale.
    if (layer.id.startsWith("railway")) layer.minzoom = 15;
    const paint = ((layer as any).paint ??= {});
    const layout = ((layer as any).layout ??= {});
    if (layer.type === "background") paint["background-color"] = dark ? "#34445b" : "#f6f4eb";
    if (layer.id === "water") paint["fill-color"] = dark ? "#1c347a" : "#8ddbf6";
    if (layer.id === "waterway") paint["line-color"] = dark ? "#1c347a" : "#8ddbf6";
    if (layer.id === "landuse_residential") {
      paint["fill-color"] = dark ? "#44486d" : "#fef5e0";
      paint["fill-opacity"] = 1;
    }
    if (layer.id.includes("park") || layer.id.includes("wood"))
      paint["fill-color"] = dark ? "#005d5b" : "#c9e9ac";
    if (
      ["road_area_pier", "aeroway-area", "landcover_ice_shelf", "landcover_glacier"].includes(
        layer.id
      )
    )
      paint["fill-color"] = dark ? "#3c4463" : "#eceae4";
    // Footprints stay a hair off the block color, as Apple draws them.
    if (layer.id === "building") {
      paint["fill-color"] = dark ? "#474b72" : "#fdf3dc";
      paint["fill-outline-color"] = dark ? "#4d5178" : "#f4e8cf";
    }
    if (layer.type === "line") {
      const colors = line[layer.id];
      paint["line-color"] = colors ? colors[dark ? 1 : 0] : dark ? "#54647b" : "#d9dbdd";
    }
    if (layer.type === "symbol") {
      paint["text-color"] = dark ? "#a9b5c6" : "#6f747b";
      paint["text-halo-color"] = dark ? "#34445b" : "#f9f7f0";
      paint["text-halo-width"] = 1.4;
    }
    if (layer.id === "water_name") paint["text-color"] = dark ? "#7d9ee6" : "#3a8fc2";
    // Neighborhoods read as spaced capitals, as in Apple Maps.
    if (layer.id === "place_suburb" || layer.id === "place_other") {
      layout["text-transform"] = "uppercase";
      layout["text-letter-spacing"] = 0.12;
      paint["text-color"] = dark ? "#8f9bb0" : "#8a8e94";
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
      "text-color": dark ? "#6f9bff" : "#2f6fd6",
      "text-halo-color": dark ? "#34445b" : "#ffffff",
      "text-halo-width": 1.8,
    },
  });
  return style;
}
