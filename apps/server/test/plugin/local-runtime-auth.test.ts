import { expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";

test.each([
  ["Authentication failed: Slack rejected the saved browser session (invalid_auth). Replace both credentials, then reconnect.", "needs_auth", "plugin_auth_failed"],
  ["MCP error -32000: Connection closed", "error", "plugin_runtime_failed"],
])("connect distinguishes provider authentication from runtime failure: %s", async (message, status, code) => {
  let connection = {
    id: crypto.randomUUID(), connectorKey: "slack-stealth", runtimeGeneration: 0,
    transport: "stdio", authType: "none", endpoint: null,
    configuration: { command: "bun", args: ["connector/server.mjs"] }, credentials: {},
    status: "disconnected", statusMessage: "", toolSnapshot: [],
    installation: { status: "installed", manifest: {} },
  };
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
      $queryRaw: async () => [],
      pluginConnection: { findUniqueOrThrow: async () => structuredClone(connection) },
    }),
    pluginConnection: {
      findUnique: async () => structuredClone(connection),
      updateMany: async ({ data }: { data: Partial<typeof connection> }) => {
        connection = { ...connection, ...data };
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const service = new PluginService(prisma, async (_path, init) =>
    init?.method === "GET"
      ? Response.json({ state: "stopped", tools: [] })
      : Response.json({ error: message }, { status: 500 })
  );
  try {
    const outcome = await Effect.runPromise(Effect.either(service.connect(connection.id)));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left).toMatchObject({ code, message });
    expect(connection.status).toBe(status!);
    expect(connection.statusMessage).toBe(status === "needs_auth" ? message! : `Local runtime unavailable: ${message}`);
  } finally {
    await service.close();
  }
});
