import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// The layered Icon Composer document is the source of truth. These full-bleed
// exports serve Expo's generic icon and the in-app About screen. Apple platforms
// compile the .icon document itself, including native dark/clear/tinted variants.
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "packages/design-tokens/assets/OpenTeam.icon");
type Fill = { solid?: string; "linear-gradient"?: string[] };
type Styled = { fill?: Fill; "fill-specializations"?: { appearance?: string; value: Fill }[] };
type Layer = Styled & { "image-name": string; name: string };
const icon = JSON.parse(readFileSync(resolve(source, "icon.json"), "utf8")) as Styled & {
  groups: { layers: Layer[] }[];
};
const fillFor = (item: Styled, appearance: string): Fill => {
  const variants = item["fill-specializations"];
  return variants?.find((entry) => entry.appearance === appearance)?.value
    ?? variants?.find((entry) => !entry.appearance)?.value
    ?? item.fill!;
};
const color = (value: string) => {
  const [r, g, b, a = 1] = value.split(":")[1].split(",").map(Number);
  return `rgba(${[r, g, b].map((channel) => Math.round(channel * 255)).join(",")},${a})`;
};

for (const appearance of ["light", "dark"]) {
  const definitions: string[] = [];
  const paint = (fill: Fill, id: string) => {
    if (fill.solid) return color(fill.solid);
    const stops = fill["linear-gradient"]!;
    definitions.push(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map((stop, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${color(stop)}"/>`).join("")}</linearGradient>`);
    return `url(#${id})`;
  };
  const background = `<rect width="1024" height="1024" fill="${paint(fillFor(icon, appearance), "background")}"/>`;
  const artwork = [...icon.groups].reverse().flatMap((group) => [...group.layers].reverse()).map((layer, index) => {
    const svg = readFileSync(resolve(source, "Assets", layer["image-name"]), "utf8");
    return svg.replace(/<svg[^>]*>/, "").replace(/<\/svg>/, "")
      .replaceAll('fill="#ffffff"', `fill="${paint(fillFor(layer, appearance), `layer-${index}`)}"`);
  }).join("");
  const stem = resolve(root, `apps/mobile/assets/openteam-icon${appearance === "dark" ? "-dark" : ""}`);
  writeFileSync(`${stem}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>OpenTeam ${appearance} app icon</title><defs>${definitions.join("")}</defs>${background}${artwork}</svg>\n`);
  execFileSync("/usr/bin/sips", ["-s", "format", "png", `${stem}.svg`, "--out", `${stem}.png`], { stdio: "ignore" });
  execFileSync("xcrun", ["swift", resolve(root, "scripts/branding/flatten-png.swift"), `${stem}.png`], { stdio: "inherit" });
  console.log(`Exported ${stem}.png`);
}
