import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentDataStore } from "@openteam/messaging";
import { parsePluginRuntimeComponents } from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../../src/plugins/catalog";
import { resolveUpstreamPlugin } from "../../src/plugins/upstream-package";

// Opt-in network QA: no provider text is copied into the repository and no account tools are called.
test.skipIf(process.env.OPENTEAM_TEST_UPSTREAM_SOURCES !== "1")(
  "pinned provider originals install, export, and materialize with exact source bytes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-original-source-"));
    try {
      const store = new AgentDataStore({} as never, {
        root,
        workspaceRoot: join(root, "workspace"),
      });
      for (const [key, skills, commands, agents, rules] of [
        ["granola", 3, 6, 1, 1],
        ["notion", 14, 0, 0, 0],
        ["linear", 0, 0, 0, 0],
      ] as const) {
        const catalog = pluginCatalog.find((plugin) => plugin.key === key)!;
        const installed = await resolveUpstreamPlugin(catalog);
        expect(installed.skills).toHaveLength(skills);
        expect(installed.connections).toEqual(catalog.connections);
        await store.syncPluginSkillCache([{ ...installed, id: key }]);
        const cache = JSON.parse(await readFile(join(root, "plugin-skills/cache.json"), "utf8"));
        const installPath = cache.packages[0].installPath;
        const exported = importPackageArchive(exportPackageArchive(installed)).definition;
        for (const [path, hash] of Object.entries(installed.upstream!.files)) {
          const name = `upstream/${path}`;
          const bytes = await readFile(join(installPath, name));
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
          const archived =
            exported.files?.[name] !== undefined
              ? Buffer.from(exported.files[name]!)
              : Buffer.from(exported.binaryFiles![name]!, "base64");
          expect(archived).toEqual(bytes);
        }
        const components = parsePluginRuntimeComponents(installed.files!);
        expect(components.commands).toHaveLength(commands);
        expect(components.agents).toHaveLength(agents);
        expect(components.rules).toHaveLength(rules);
        expect(components.warnings).toEqual([]);
        const offline = async () => {
          throw new Error("Unexpected source download");
        };
        expect(await resolveUpstreamPlugin(catalog, offline, installed)).toEqual(installed);
        console.log(
          `${key}: ${Object.keys(installed.upstream!.files).length} source files, ${skills} skills, ${commands} commands verified`
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000
);
