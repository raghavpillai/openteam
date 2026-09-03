import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";

/** Electron's Chromium runtime supports WOFF2; shipping KaTeX's WOFF and TTF
 * fallbacks only adds duplicate font payload to every installer. */
const katexWoff2Only = (): Plugin => ({
  name: "openteam-katex-woff2-only",
  enforce: "pre",
  transform(source, id) {
    if (!/[\\/]katex[\\/]dist[\\/]katex\.min\.css(?:\?|$)/.test(id)) return;
    return source.replace(
      /src:(url\([^)]*?\.woff2\)\s*format\(["']woff2["']\))(?:,url\([^)]*?\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\))+/g,
      "src:$1"
    );
  },
});

type EmojiRuntimeSource = {
  emoticon?: string | string[];
  group?: number;
  label: string;
  order?: number;
  tags?: string[];
  unicode: string;
};

/** Keep only the English fields rendered or searched by the picker. The npm
 * corpus also contains hex codes, skin-tone metadata, and other fields that
 * otherwise survive JSON bundling even though the desktop never reads them. */
const emojiPickerRuntimeData = (): Plugin => ({
  name: "openteam-emoji-picker-runtime-data",
  enforce: "pre",
  transform(source, id) {
    if (!/[\\/]emojibase-data[\\/]en[\\/]compact\.json(?:\?|$)/.test(id)) return;
    const supportedGroups = new Set([0, 1, 3, 4, 5, 6, 7, 8, 9]);
    const entries = (JSON.parse(source) as EmojiRuntimeSource[])
      .filter((entry) => entry.group !== undefined && supportedGroups.has(entry.group))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map(({ unicode, label, group, order, tags, emoticon }) => ({
        unicode,
        label,
        group,
        order,
        tags,
        emoticon,
      }));
    return JSON.stringify(entries);
  },
});

/** Opt-in build evidence for finding what actually contributes to each chunk.
 * It is intentionally absent from ordinary and release builds. */
const bundleModuleAudit = (): Plugin => ({
  name: "openteam-bundle-module-audit",
  generateBundle(_options, bundle) {
    if (process.env.OPENTEAM_BUILD_ANALYZE !== "1") return;
    const chunks = Object.values(bundle)
      .filter((output) => output.type === "chunk")
      .map((chunk) => ({
        file: chunk.fileName,
        bytes: chunk.code.length,
        modules: Object.entries(chunk.modules)
          .map(([id, details]) => ({
            id,
            renderedBytes: details.renderedLength,
          }))
          .sort((left, right) => right.renderedBytes - left.renderedBytes),
      }))
      .sort((left, right) => right.bytes - left.bytes);
    this.emitFile({
      type: "asset",
      fileName: "bundle-module-audit.json",
      source: JSON.stringify({ generatedAt: new Date().toISOString(), chunks }, null, 2),
    });
  },
});

const noVncProxies = Object.fromEntries(
  Array.from({ length: 100 }, (_, index) => 6200 + index).map((port) => {
    const route = `/novnc/${port}`;
    const options: ProxyOptions = {
      target: `http://127.0.0.1:${port}`,
      ws: true,
      rewrite: (path) => path.slice(route.length) || "/",
    };
    return [route, options];
  })
);

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    katexWoff2Only(),
    emojiPickerRuntimeData(),
    bundleModuleAudit(),
    tailwindcss(),
  ],
  server: {
    host: process.env.OPENTEAM_DEV_HOST ?? "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": process.env.OPENTEAM_SERVER_URL ?? "http://127.0.0.1:8787",
      ...noVncProxies,
    },
  },
  worker: { format: "es" },
  build: { manifest: "manifest.json", outDir: "dist" },
});
