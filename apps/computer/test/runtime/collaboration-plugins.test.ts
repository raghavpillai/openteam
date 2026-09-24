import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { parseSkillMarkdown } from "@openteam/plugin-sdk/skill-markdown";
import { parsePluginRuntimeComponents, type PluginRuntimePackage } from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../../../../packages/plugins/src";
import { expandPluginAgent, pluginComponentsExtension } from "../../src/runtime/plugin-components";

for (const [key, skillCount, commands] of [
  [
    "slack",
    8,
    ["channel-digest", "draft-announcement", "find-discussions", "standup", "summarize-channel"],
  ],
  ["granola", 3, ["brief", "bug-report", "gaps", "plan", "pr", "spec"]],
] as const) {
  test(`${key} workflows survive export and dispatch with arguments and supporting files`, async () => {
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
    const pkg: PluginRuntimePackage = {
      ...components,
      key,
      installPath: `/agent-data/plugins/cache/${key}`,
    };
    const events: Record<string, (event: any) => Promise<any>> = {};
    await pluginComponentsExtension(
      { pluginRuntimePackages: [pkg] } as any,
      async () => {
        throw new Error("These workflows have no inference hooks");
      },
      async () => {
        throw new Error("These workflows have no approval hooks");
      }
    ).factory({
      on: (name: string, handler: any) => {
        events[name] = handler;
      },
    } as any);
    const context = await events.before_agent_start!({ prompt: "Prepare for the release meeting" });
    for (const command of components.commands) {
      const prompt = `/${key}:${command.name} release scope, last 7 days`;
      const result = await events.input!({ text: prompt });
      expect(result.action).toBe("transform");
      expect(result.text).toContain("release scope, last 7 days");
      expect(result.text).not.toContain("$ARGUMENTS");
      expect(context.message.content).toContain(`/${key}:${command.name}`);
    }
    expect(await events.input!({ text: `/${key}:${commands[0]}-unknown topic` })).toBeUndefined();
    // Check actual source files as well as the generated registry so stale bundles cannot pass.
    for (const [path, body] of Object.entries(definition.files ?? {})) {
      if (!/\.(?:md|mdc)$/.test(path)) continue;
      // Export re-renders skill frontmatter; bodies and supporting links must remain intact.
      if (!path.endsWith("/SKILL.md")) {
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
    if (key === "granola") {
      expect(context.message.content).toContain(
        "A task unrelated to meetings does not need a Granola search"
      );
      expect(context.message.content).toContain('plugin_agent="granola:engineer"');
      const expanded = expandPluginAgent([pkg], {
        plugin_agent: "granola:engineer",
        prompt: "Implement the approved parser fix",
      });
      expect(expanded.prompt).toContain("Implement the approved parser fix");
      expect(expanded.prompt).toContain("meeting decisions");
      expect(expanded.prompt).toContain("parent actually assigned");
    } else {
      expect(definition.files?.["LICENSE"]).toContain("MIT");
      expect(definition.files?.["skills/block-kit/references/common-patterns.md"]).toBeTruthy();
    }
  });
}
