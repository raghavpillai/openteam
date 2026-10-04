import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginRuntimeComponents, type PluginRuntimePackage } from "@openteam/plugin-sdk";
import {
  expandPluginAgent,
  pluginComponentsExtension,
  runPluginCommand,
} from "../../src/runtime/plugin-components";

test("installed hooks preserve commands and templates without review gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-hooks-"));
  const previous = process.env.OPENTEAM_AGENT_DATA_ROOT;
  process.env.OPENTEAM_AGENT_DATA_ROOT = root;
  const installPath = join(root, "plugins/cache/fixture/v1");
  try {
    await mkdir(installPath, { recursive: true });
    await writeFile(
      join(installPath, "guard.sh"),
      `#!/bin/sh\ncat >/dev/null\nprintf '{"permission":"deny","reason":"Fixture denied write"}'\n`,
      { mode: 0o555 }
    );
    const components = parsePluginRuntimeComponents({
      "hooks/hooks.json": JSON.stringify({
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: "./guard.sh", matcher: "rm" }],
        },
      }),
      "commands/review.md": "---\ndescription: Review changes\n---\nReview $ARGUMENTS",
      "rules/code.mdc":
        "---\nglobs: '**/*.ts'\nalwaysApply: false\n---\nUse explicit return types.",
      "agents/reviewer.md":
        "---\ndescription: Audit code\nreadonly: true\nmodel: fixture/model\n---\nReview changes and report defects.",
    });
    const pkg: PluginRuntimePackage = { ...components, key: "fixture", installPath };
    const events: Record<string, any> = {};
    const messages: any[] = [];
    const active = {
      runId: "run",
      contextSessionId: "room",
      cwd: root,
      pluginRuntimePackages: [pkg],
      pluginAbortController: new AbortController(),
    } as any;
    const extension = pluginComponentsExtension(active);
    await extension.factory({
      on: (name: string, handler: any) => {
        events[name] = handler;
      },
      sendMessage: (message: any) => messages.push(message),
      sendUserMessage() {},
    } as any);
    expect(await events.input({ text: "/fixture:review the parser" })).toMatchObject({
      action: "transform",
      text: "Review the parser",
    });
    expect(
      await events.tool_call({
        toolName: "Shell",
        toolCallId: "write",
        input: { command: "rm file" },
      })
    ).toBeUndefined();
    expect(
      await events.tool_call({ toolName: "Shell", toolCallId: "read", input: { command: "pwd" } })
    ).toBeUndefined();
    expect(
      await events.tool_call({
        toolName: "Read",
        toolCallId: "file",
        input: { path: "src/code.ts" },
      })
    ).toBeUndefined();
    expect(messages.some((message) => message.content.includes("explicit return types"))).toBe(
      true
    );
    expect(
      expandPluginAgent([pkg], { plugin_agent: "fixture:reviewer", prompt: "Audit parser" })
    ).toMatchObject({
      read_only: true,
      subagent_type: "executor",
      run_in_background: false,
    });
    expect(() =>
      expandPluginAgent([pkg], { plugin_agent: "fixture:reviewer", resume: "existing" })
    ).toThrow("fixed template");
    const secretResult = await runPluginCommand(
      'printf "%s" "$OPENTEAM_CONTROL_TOKEN"',
      installPath,
      { cwd: root },
      new AbortController().signal,
      2000
    );
    expect(secretResult.output).toBe("");
    const controller = new AbortController();
    const pending = runPluginCommand("sleep 30", installPath, {}, controller.signal, 30_000);
    controller.abort(new Error("Fixture cancellation"));
    await expect(pending).rejects.toThrow("cancellation");
  } finally {
    if (previous === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
    else process.env.OPENTEAM_AGENT_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported component permissions cannot silently broaden an imported agent", () => {
  const parsed = parsePluginRuntimeComponents({
    "agents/restricted.md": "---\ntools: Read\n---\nRead only",
  });
  expect(parsed.agents).toEqual([]);
  expect(parsed.warnings[0]).toContain("disabled");
  expect(() =>
    parsePluginRuntimeComponents({
      "hooks/hooks.json": '{"hooks":{"beforeShellExecution":[{"command":"echo ok","timeout":0}]}}',
    })
  ).toThrow("timeout");
});

// Imported templates are content, not inference configuration.
test("plugin agent model preferences do not become Task inference controls", () => {
  const components = parsePluginRuntimeComponents({
    "agents/reviewer.md": "---\ndescription: Audit\nmodel: provider/expensive\n---\nReview the files.",
  });
  const pkg = { ...components, key: "fixture", installPath: "/tmp/fixture" };
  const expanded = expandPluginAgent([pkg], { plugin_agent: "fixture:reviewer", prompt: "Review" });
  expect(expanded.model).toBeUndefined();
  expect(expanded.prompt).toContain("Review the files.");
});
