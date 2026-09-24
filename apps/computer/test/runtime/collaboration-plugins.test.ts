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
  ["1password", 1, []],
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
      installPath: `/agent-data/plugins/cache/${key}/upstream`,
      ...(key === "1password"
        ? { hooksUnavailableReason: "Desktop filesystem hook is unavailable on the Bot computer." }
        : {}),
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
      // Original frontmatter, bodies, and supporting files remain byte-identical.
      {
        expect(body).toBe(
          await readFile(
            new URL(`../../../../packages/plugins/${key}/${path}`, import.meta.url),
            "utf8"
          )
        );
      }
      if (!/^upstream\/(skills|commands|agents|rules)\//.test(path)) continue;
      for (const [, relative] of body.matchAll(/\]\((\.{1,2}\/[^)#]+)(?:#[^)]*)?\)/g)) {
        const target = posix.normalize(posix.join(posix.dirname(path), relative!));
        expect(definition.files?.[target]).toBeDefined();
      }
    }
    if (key === "1password") {
      expect(components.hooks).toHaveLength(1);
      expect(context.message.content).toContain("Desktop filesystem hook is unavailable");
      // This must skip the preserved desktop-only hook rather than executing it on the Bot host.
      expect(
        await events.tool_call!({ toolName: "Shell", input: { command: "echo fixture" } })
      ).toBeUndefined();
    } else {
      expect(definition.files?.["upstream/LICENSE"]).toContain("MIT");
      expect(
        definition.files?.["upstream/skills/block-kit/references/common-patterns.md"]
      ).toBeTruthy();
    }
  });
}

test("original command names and legacy aliases dispatch without ambiguous flat names", async () => {
  const pkg: PluginRuntimePackage = {
    key: "granola",
    installPath: "/cache/granola/upstream",
    hooks: [],
    warnings: [],
    commands: [{ name: "granola-plan", description: "Plan", body: "Plan from $ARGUMENTS" }],
    agents: [
      { name: "granola-engineer", description: "Engineer", body: "Original agent instructions." },
    ],
    rules: [
      {
        name: "meeting-context",
        description: "Context",
        body: "Original rule.",
        alwaysApply: true,
        globs: [],
      },
    ],
  };
  const events: Record<string, (event: any) => Promise<any>> = {};
  const install = async (packages: PluginRuntimePackage[]) => {
    await pluginComponentsExtension(
      { pluginRuntimePackages: packages } as any,
      async () => {
        throw new Error("Unexpected hook");
      },
      async () => false
    ).factory({
      on: (name: string, handler: any) => {
        events[name] = handler;
      },
    } as any);
  };
  await install([pkg]);
  for (const command of ["/granola-plan", "/granola:granola-plan", "/granola:plan"]) {
    expect((await events.input!({ text: `${command} release` })).text).toBe("Plan from release");
  }
  const context = await events.before_agent_start!({ prompt: "release" });
  expect(context.message.content).toContain("Original rule.");
  expect(context.message.content).toContain('plugin_agent="granola:granola-engineer"');
  for (const name of ["granola:granola-engineer", "granola:engineer"]) {
    const expanded = expandPluginAgent([pkg], { plugin_agent: name, prompt: "Assigned work" });
    expect(expanded.prompt).toContain("Original agent instructions.");
    expect(expanded.prompt).toContain("Assigned work");
    expect(expanded.prompt).toContain(pkg.installPath);
  }
  await install([pkg, { ...pkg, key: "duplicate" }]);
  expect(await events.input!({ text: "/granola-plan release" })).toBeUndefined();
  expect((await events.input!({ text: "/granola:granola-plan release" })).text).toBe(
    "Plan from release"
  );
});

test.skipIf(process.env.OPENTEAM_TEST_UPSTREAM_SOURCES !== "1")(
  "all original Granola commands and its agent dispatch from the pinned provider source",
  async () => {
    const { resolveUpstreamPlugin } = await import("../../../server/src/plugins/upstream-package");
    const original = await resolveUpstreamPlugin(
      pluginCatalog.find((plugin) => plugin.key === "granola")!
    );
    const pkg: PluginRuntimePackage = {
      ...parsePluginRuntimeComponents(original.files!),
      key: "granola",
      installPath: "/cache/granola/upstream",
    };
    expect(pkg.commands).toHaveLength(6);
    const events: Record<string, (event: any) => Promise<any>> = {};
    await pluginComponentsExtension(
      { pluginRuntimePackages: [pkg] } as any,
      async () => {
        throw new Error("Unexpected hook");
      },
      async () => false
    ).factory({
      on: (name: string, handler: any) => {
        events[name] = handler;
      },
    } as any);
    for (const command of pkg.commands) {
      const expanded = await events.input!({ text: `/${command.name} fixture release` });
      expect(expanded.action).toBe("transform");
      expect(expanded.text).toContain("fixture release");
      expect(expanded.text).not.toContain("$ARGUMENTS");
    }
    const context = await events.before_agent_start!({ prompt: "fixture release" });
    expect(context.message.content).toContain(pkg.rules[0]!.body);
    for (const agent of pkg.agents)
      expect(
        expandPluginAgent([pkg], { plugin_agent: `granola:${agent.name}`, prompt: "Assigned work" })
          .prompt
      ).toContain(agent.body);
  },
  60_000
);
