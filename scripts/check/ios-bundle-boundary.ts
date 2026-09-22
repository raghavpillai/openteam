import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const bundleDirectory = resolve(root, "apps/ios/Sources/App/Resources");
const forbidden = [
  "CallDynamicTool",
  "GetDynamicTools",
  "ExternalShell",
  "Missing native tool definition",
];

const entries = await readdir(bundleDirectory);
const bundles = entries.filter((entry) => entry.endsWith(".html"));
for (const bundle of bundles) {
  const bytes = await Bun.file(resolve(bundleDirectory, bundle)).arrayBuffer();
  const text = new TextDecoder("latin1").decode(bytes);
  const leaked = forbidden.filter((marker) => text.includes(marker));
  if (leaked.length > 0) {
    throw new Error(`Mobile bundle contains server/tool markers: ${leaked.join(", ")}`);
  }
}
console.log(
  bundles.length > 0
    ? `Checked ${bundles.length} mobile bundle(s)`
    : "No built mobile bundle found; source boundary check remains authoritative"
);

if (bundles.length < 3) throw new Error("Missing bundled iOS document/computer renderers");
