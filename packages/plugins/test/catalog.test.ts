import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginTemplate,
} from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { discoverPackages } from "../scripts/generate";
import { pluginCatalog } from "../src";

test("contributions discover without imports and folder names do not change package identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-catalog-"));
  try {
    await mkdir(join(root, ".turbo"));
    await mkdir(join(root, "a-folder"));
    const definition = createPluginTemplate("hybrid", "stable-identity");
    await writeFile(join(root, "a-folder/plugin.json"), JSON.stringify(definition));
    await writeFile(join(root, "a-folder/README.md"), "Contributor documentation");
    await mkdir(join(root, "a-folder/connector/test/fixtures"), { recursive: true });
    await writeFile(join(root, "a-folder/connector/test/fixtures/sample.json"), "{}");
    await writeFile(join(root, "a-folder/connector/server.test.ts"), "test-only source");
    await writeFile(join(root, "a-folder/connector/test_server.py"), "test-only source");
    const catalog = await discoverPackages(root);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.key).toBe("stable-identity");
    expect(catalog[0]?.files?.["README.md"]).toBe("Contributor documentation");
    expect(catalog[0]?.files?.["connector/server.mjs"]).toContain("tools/call");
    expect(catalog[0]?.files?.["connector/test/fixtures/sample.json"]).toBeUndefined();
    expect(catalog[0]?.files?.["connector/server.test.ts"]).toBeUndefined();
    expect(catalog[0]?.files?.["connector/test_server.py"]).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every registry package declares its origin and shipped provider files survive export byte for byte", async () => {
  for (const plugin of pluginCatalog) {
    const audit = await Bun.file(new URL(`../${plugin.key}/upstream.json`, import.meta.url)).json();
    if (audit.origin === "openteam") {
      expect(plugin.upstream).toBeUndefined();
      continue;
    }
    expect(plugin.upstream).toEqual(audit);
    expect(plugin.sourceRevision).toBe(audit.revision);
    const roundtrip = importPackageArchive(exportPackageArchive(plugin)).definition;
    if (audit.delivery === "install") {
      expect(plugin.skills.every((skill) => skill.body === "")).toBe(true);
      expect(Object.keys(roundtrip.files ?? {}).some((path) => path.startsWith("upstream/"))).toBe(
        false
      );
      continue;
    }
    for (const [path, expected] of Object.entries(audit.files)) {
      const local = await readFile(new URL(`../${plugin.key}/upstream/${path}`, import.meta.url));
      expect(createHash("sha256").update(local).digest("hex")).toBe(expected as string);
      const key = `upstream/${path}`;
      const exported = roundtrip.binaryFiles?.[key]
        ? Buffer.from(roundtrip.binaryFiles[key]!, "base64")
        : Buffer.from(roundtrip.files?.[key] ?? "");
      expect(exported).toEqual(local);
    }
    expect(plugin.files?.["OPENTEAM.md"]).toBeUndefined();
  }
}, 30_000);

const roundtrip = (key: string) =>
  importPackageArchive(exportPackageArchive(pluginCatalog.find((plugin) => plugin.key === key)!));
