import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { importPackage, parsePluginDefinition } from "@openteam/plugin-sdk";

const root = join(import.meta.dir, "..");
const check = process.argv.includes("--check");
let count = 0;
for (const folder of await readdir(root, { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  const descriptor = Bun.file(join(root, folder.name, "upstream.json"));
  if (!(await descriptor.exists())) continue;
  const upstream = await descriptor.json();
  if (upstream.origin === "openteam") continue;
  const host = await readFile(join(root, folder.name, "plugin.json"), "utf8");
  const source = parsePluginDefinition({
    ...importPackage({ "plugin.json": host }).definition,
    upstream,
  }).upstream!;
  if (check && source.delivery === "install") continue;
  for (const [path, expected] of Object.entries(source.files)) {
    const destination = join(root, folder.name, "upstream", path);
    let bytes: Uint8Array;
    if (check) bytes = await readFile(destination);
    else {
      const location = [source.directory, path]
        .filter(Boolean)
        .join("/")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const response = await fetch(
        `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${location}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (!response.ok) throw new Error(`Cannot fetch ${folder.name}/${path}: ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`Source mismatch: ${folder.name}/${path}`);
    if (!check && source.delivery !== "install") {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    count++;
  }
}
console.log(
  `Verified ${count} original files${check ? " locally" : " against pinned upstream commits"}`
);
