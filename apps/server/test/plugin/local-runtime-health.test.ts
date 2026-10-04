import { expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { PluginService } from "../../src/services/plugin-service";

test("background MCP health only observes pending, failed, stopped, and ready processes", async () => {
  let state = "starting";
  const paths: string[] = [];
  let connection = {
    id: crypto.randomUUID(),
    transport: "stdio",
    status: "error",
    configuration: {},
    statusMessage: "Local runtime unavailable: startup timed out",
    updatedAt: new Date(),
    toolSnapshot: [],
    installation: { status: "installed" },
  };
  const prisma = {
    pluginConnection: {
      findMany: async () => [structuredClone(connection)],
      findUnique: async () => structuredClone(connection),
      updateMany: async ({ data }: { data: Partial<typeof connection> }) => {
        connection = {
          ...connection,
          ...data,
          updatedAt: new Date(connection.updatedAt.getTime() + 1),
        };
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const service = new PluginService(prisma, async (path, init) => {
    paths.push(path);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    return Response.json({
      state,
      tools: state === "ready" ? [{ name: "echo", inputSchema: { type: "object" } }] : [],
    });
  });
  const internal = service as unknown as {
    refreshLocalConnections(): Promise<void>;
    markReady(connection: unknown, tools: unknown[]): Promise<void>;
  };
  internal.markReady = async (_, tools) => {
    connection = {
      ...connection,
      status: "ready",
      statusMessage: "",
      toolSnapshot: tools as never[],
    };
  };
  try {
    for (let i = 0; i < 5; i++) await internal.refreshLocalConnections();
    expect(connection.status).toBe("needs_auth");
    expect(connection.statusMessage).toContain("Complete any browser sign-in prompt");
    state = "ready";
    await internal.refreshLocalConnections();
    expect(connection.status).toBe("ready");
    expect(connection.toolSnapshot).toHaveLength(1);
    for (state of ["error", "stopped"]) {
      for (let i = 0; i < 5; i++) await internal.refreshLocalConnections();
      expect(connection.status).toBe("error");
      expect(connection.statusMessage).toContain("Reconnect to try again");
    }
    expect(paths).toHaveLength(16);
    expect(paths.every((path) => path === `/v1/mcp/connections/${connection.id}`)).toBe(true);
  } finally {
    await service.close();
  }
});
