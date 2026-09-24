import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../src";

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
});
