import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { pluginCatalog } from "@openteam/plugins";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
// Actual tools/list contracts from the installed 1Password 8.12.36 binary (2026-09-14).
// These are provider schemas, not an authenticated account response.
import nativeTools from "./fixtures/onepassword-tools.json";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)("desktop plugin configuration, error recovery, discovery policies, account copies, and disconnect", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const definition = structuredClone(pluginCatalog.find((plugin) => plugin.key === "1password")!);
  definition.key = `desktop-qa-${crypto.randomUUID()}`;
  let blocked = true;
  const closed: string[] = [];
  const calls: Array<{ toolName: string; arguments: Record<string, unknown> }> = [];
  let discoveries = 0;
  const service = new PluginService(prisma, async (path, init) => {
    if (init?.method === "DELETE") { closed.push(path); return Response.json({ ok: true }); }
    const body = JSON.parse(String(init?.body));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(body.configuration.runtime).toBe("desktop");
    expect(body.configuration.provider).toBe("1password");
    expect(body.configuration.command).toBe("1password-mcp");
    expect(Object.keys(body.configuration.env)).toEqual(["OPENTEAM_PLUGIN_ACCOUNT_ID"]);
    if (blocked) return Response.json({ error: "Unlock 1Password and enable MCP Server" }, { status: 400 });
    if (path.endsWith("/discover")) {
      discoveries += 1;
      return Response.json({ tools: nativeTools });
    }
    calls.push({ toolName: body.toolName, arguments: body.arguments });
    return Response.json({ result: { content: [{ type: "text", text: `Account ${body.arguments.accountId}` }] } });
  });
  let draftId = "";
  try {
    const draft = await Effect.runPromise(service.management.importFiles({ "plugin.json": JSON.stringify(definition) }));
    draftId = draft.id;
    await Effect.runPromise(service.management.installDraft(draft.id));
    const connection = await prisma.pluginConnection.findFirstOrThrow({ where: { installation: { pluginKey: definition.key } } });
    const config = await Effect.runPromise(service.configuration.get(connection.id));
    expect(config.runtime).toBe("desktop");
    expect(config.fields).toHaveLength(0);
    await expect(Effect.runPromise(service.configuration.save(connection.id, { command: "sh" }))).rejects.toThrow("Unsupported");
    await expect(Effect.runPromise(service.configuration.save(connection.id, { env: { OP_SERVICE_ACCOUNT_TOKEN: "never-forward" } }))).rejects.toThrow("environment variables");
    await expect(Effect.runPromise(service.connect(connection.id))).rejects.toThrow("Unlock 1Password");
    expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } })).status).toBe("error");
    blocked = false;
    expect(await Effect.runPromise(service.connect(connection.id))).toMatchObject({ status: "ready", toolCount: 8 });
    const ready = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(ready.toolSnapshot).toHaveLength(8);
    for (const tool of ready.toolSnapshot as Array<{ name: string; risk: string; defaultDecision: string }>) {
      const readOnly = tool.name.startsWith("list_");
      expect(tool).toMatchObject({ risk: readOnly ? "read" : "write", defaultDecision: readOnly ? "allow" : "prompt" });
    }
    // Exercise the real health-check path without waiting for its 15-second timer.
    await service["refreshLocalConnections"]();
    expect(discoveries).toBe(1);
    expect(JSON.stringify(await Effect.runPromise(service.testTool(connection.id, { toolName: "list_environments", arguments: { accountId: "fixture-account" } })))).toContain("fixture-account");
    await expect(Effect.runPromise(service.testTool(connection.id, { toolName: "append_variables", arguments: {} }))).rejects.toThrow();
    const common = { accountId: "fixture-account", environmentId: "fixture-environment" };
    const argumentsByTool: Record<string, Record<string, unknown>> = {
      authenticate: {},
      list_environments: { accountId: common.accountId },
      create_environment: { accountId: common.accountId, environmentName: "Disposable fixture" },
      rename_environment: { ...common, environmentName: "Renamed fixture" },
      list_variables: common,
      append_variables: { ...common, variables: [{ name: "OPENTEAM_TEST", value: "dummy", concealed: false }] },
      list_local_env_files: common,
      create_local_env_file: { ...common, environmentName: "Disposable fixture", mountPath: "/tmp/openteam-fixture.env" },
    };
    for (const tool of nativeTools) {
      const args = argumentsByTool[tool.name]!;
      const before = calls.length;
      await Effect.runPromise(service.testTool(connection.id, { toolName: tool.name, arguments: args, confirmSideEffect: true }));
      expect(calls).toHaveLength(before + 1);
      expect(calls.at(-1)).toEqual({ toolName: tool.name, arguments: args });
      if (tool.name !== "authenticate") {
        await expect(Effect.runPromise(service.testTool(connection.id, { toolName: tool.name, arguments: {}, confirmSideEffect: true }))).rejects.toThrow();
        expect(calls).toHaveLength(before + 1);
      }
    }
    await expect(Effect.runPromise(service.testTool(connection.id, {
      toolName: "append_variables", confirmSideEffect: true,
      arguments: { ...common, variables: [{ name: "OPENTEAM_TEST", value: "dummy", concealed: "false" }] },
    }))).rejects.toThrow();
    await prisma.pluginConnection.update({ where: { id: connection.id }, data: { status: "error", statusMessage: "Local runtime unavailable: desktop locked" } });
    await service["refreshLocalConnections"]();
    expect(discoveries).toBe(1);
    expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } })).status).toBe("error");
    await Effect.runPromise(service.connect(connection.id));
    expect(discoveries).toBe(2);
    const action = { action: "AuthenticateMcpServer", rawArguments: { connectionId: connection.id, forceReauth: true } };
    expect(await service.resolveAction(action, "decline")).toEqual({ status: "declined" });
    expect(discoveries).toBe(2);
    expect(await service.resolveAction(action, "accept")).toMatchObject({ status: "ready", toolCount: 8 });
    expect(closed.some((path) => path.includes(connection.id))).toBe(true);
    expect(discoveries).toBe(3);
    const second = await Effect.runPromise(service.addAccount(connection.id, "second"));
    expect((await Effect.runPromise(service.configuration.get(second.id))).runtime).toBe("desktop");
    await Effect.runPromise(service.connect(second.id));
    await Effect.runPromise(service.disconnect(connection.id));
    expect(closed.some((path) => path.includes(connection.id))).toBe(true);
    expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("ready");
  } finally {
    await service.close();
    await prisma.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
    if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
    await prisma.$disconnect();
  }
}, 60_000);
