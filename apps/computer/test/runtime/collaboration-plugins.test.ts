import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { parseSkillMarkdown } from "@openteam/plugin-sdk/skill-markdown";
import { parsePluginRuntimeComponents } from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../../../../packages/plugins/src";

for (const [key, skillCount, commands] of [
  [
    "slack",
    8,
    ["channel-digest", "draft-announcement", "find-discussions", "standup", "summarize-channel"],
  ],
] as const) {
  test(`${key} workflows survive export with their commands and supporting files`, async () => {
    const source = pluginCatalog.find((plugin) => plugin.key === key)!;
    const { definition, warnings } = importPackageArchive(exportPackageArchive(source));
    expect(warnings).toEqual([]);
    expect(definition.skills).toHaveLength(skillCount);
    for (const skill of definition.skills) {
      const markdown = await readFile(
        new URL(`../../../../packages/plugins/${key}/${skill.path}/SKILL.md`, import.meta.url),
        "utf8"
      );
      expect(skill.body).toBe(parseSkillMarkdown(markdown, skill.name).body);
    }
    expect(definition.connections).toEqual(source.connections);
    const components = parsePluginRuntimeComponents(definition.files ?? {});
    expect(components.commands.map((command) => command.name).sort()).toEqual([...commands]);
    // Check actual source files as well as the generated registry so stale bundles cannot pass.
    for (const [path, body] of Object.entries(definition.files ?? {})) {
      if (!/\.(?:md|mdc)$/.test(path)) continue;
      // Original frontmatter, bodies, and supporting files remain byte-identical.
      {
        expect(body).toBe(
          await readFile(
            new URL(`../../../../packages/plugins/${key}/${path}`, import.meta.url),
            "utf8"
          )
        );
      }
      if (!/^(skills|commands|agents|rules)\//.test(path)) continue;
      for (const [, relative] of body.matchAll(/\]\((\.{1,2}\/[^)#]+)(?:#[^)]*)?\)/g)) {
        const target = posix.normalize(posix.join(posix.dirname(path), relative!));
        expect(definition.files?.[target]).toBeDefined();
      }
    }
    expect(definition.files?.["LICENSE"]).toContain("MIT");
    expect(definition.files?.["skills/block-kit/references/common-patterns.md"]).toBeTruthy();
  });
}

