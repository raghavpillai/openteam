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

test("installed hooks gate real commands, ask through review, expand commands and agent templates", async () => {
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
          preToolUse: [{ type: "prompt", prompt: "Check $ARGUMENTS", matcher: "Read" }],
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
    const approvals: any[] = [];
    const active = {
      runId: "run",
      contextSessionId: "room",
      cwd: root,
      pluginRuntimePackages: [pkg],
      pluginAbortController: new AbortController(),
    } as any;
    const extension = pluginComponentsExtension(
      active,
      async (prompt) => {
        expect(prompt).toContain('"tool_name":"Read"');
        return '{"permission":"ask","reason":"Read review"}';
      },
      async (...input) => {
        approvals.push(input);
        return false;
      }
    );
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
    ).toMatchObject({ block: true, reason: "Fixture denied write" });
    expect(
      await events.tool_call({ toolName: "Shell", toolCallId: "read", input: { command: "pwd" } })
    ).toBeUndefined();
    expect(
      await events.tool_call({
        toolName: "Read",
        toolCallId: "file",
        input: { path: "src/code.ts" },
      })
    ).toMatchObject({ block: true });
    expect(approvals).toHaveLength(1);
    expect(messages.some((message) => message.content.includes("explicit return types"))).toBe(
      true
    );
    expect(
      expandPluginAgent([pkg], { plugin_agent: "fixture:reviewer", prompt: "Audit parser" })
    ).toMatchObject({
      read_only: true,
      model: "fixture/model",
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
