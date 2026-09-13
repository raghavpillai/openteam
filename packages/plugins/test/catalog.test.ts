import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginTemplate, pluginIconUrl } from "@openteam/plugin-sdk";
import { discoverPackages } from "../scripts/generate";
import { pluginCatalog } from "../src";

test("every bundled package includes portable provider artwork", async () => {
  const catalog = pluginCatalog;
  expect(catalog.length).toBeGreaterThanOrEqual(9);
  for (const plugin of catalog) {
    expect(plugin.icon).toBe("assets/icon.png");
    expect(pluginIconUrl(plugin)).toStartWith("data:image/png;base64,");
    const png = Buffer.from(plugin.binaryFiles![plugin.icon!]!, "base64");
    expect(png).toEqual(
      await readFile(new URL(`../${plugin.key}/assets/icon.png`, import.meta.url))
    );
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(192);
    expect(png.readUInt32BE(20)).toBe(192);
    expect(plugin.files?.["assets/SOURCES.md"]).toBeTruthy();
  }
});

test("contributions discover without imports and folder names do not change package identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-catalog-"));
  try {
    await mkdir(join(root, ".turbo"));
    await mkdir(join(root, "a-folder"));
    const definition = createPluginTemplate("hybrid", "stable-identity");
    await writeFile(join(root, "a-folder/plugin.json"), JSON.stringify(definition));
    await writeFile(join(root, "a-folder/README.md"), "Contributor documentation");
    const catalog = await discoverPackages(root);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.key).toBe("stable-identity");
    expect(catalog[0]?.files?.["README.md"]).toBe("Contributor documentation");
    expect(catalog[0]?.files?.["connector/server.mjs"]).toContain("tools/call");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
