import { expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { PluginService } from "../../src/services/plugin-service";

test("background MCP health observes processes and resumes stopped connections on next use", async () => {
  let state = "starting";
  let error: string | undefined;
  let writes = 0;
  const resumed: string[] = [];
  const paths: string[] = [];
  let connection = {
    id: crypto.randomUUID(),
    transport: "stdio",
    status: "error",
    configuration: {},
    statusMessage: "Local runtime unavailable: startup timed out",
    updatedAt: new Date(),
    toolSnapshot: [] as unknown[],
    installation: { status: "installed" },
  };
  const prisma = {
    pluginConnection: {
      findMany: async () => [structuredClone(connection)],
      findUnique: async () => structuredClone(connection),
      updateMany: async ({ data }: { data: Partial<typeof connection> }) => {
        writes++;
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
      ...(error ? { error } : {}),
    });
  });
  const internal = service as unknown as {
    refreshLocalConnections(): Promise<void>;
    markReady(connection: unknown, tools: unknown[], kind?: string): Promise<void>;
  };
  internal.markReady = async (_, tools, kind) => {
    resumed.push(kind ?? "connection.ready");
    connection = {
      ...connection,
      status: "ready",
      statusMessage: "",
      toolSnapshot: tools,
      updatedAt: new Date(connection.updatedAt.getTime() + 1),
    };
  };
  try {
    for (let i = 0; i < 5; i++) await internal.refreshLocalConnections();
    expect(connection.status).toBe("needs_auth");
    expect(connection.statusMessage).toContain("Complete any browser sign-in prompt");

    // A restart during a pending sign-in is not a working connection to resume.
    state = "stopped";
    await internal.refreshLocalConnections();
    expect(connection.status).toBe("error");
    expect(connection.statusMessage).toContain("Sign-in was interrupted");

    state = "ready";
    await internal.refreshLocalConnections();
    expect(connection.status).toBe("ready");
    expect(connection.toolSnapshot).toHaveLength(1);

    // After a restart or plugin update, a working connection stays ready and
    // starts on its next call. The health check launches nothing and writes nothing.
    state = "stopped";
    const before = writes;
    for (let i = 0; i < 5; i++) await internal.refreshLocalConnections();
    expect(connection.status).toBe("ready");
    expect(writes).toBe(before);

    // A process that failed keeps the computer's reason.
    state = "error";
    error = "MCP process exited. Reconnect to try again.";
    for (let i = 0; i < 5; i++) await internal.refreshLocalConnections();
    expect(connection.status).toBe("error");
    expect(connection.statusMessage).toBe("Local runtime unavailable: MCP process exited. Reconnect to try again.");

    // Connections that older health checks marked broken after a restart recover.
    state = "stopped";
    error = undefined;
    connection = {
      ...connection,
      status: "error",
      statusMessage: "Local runtime unavailable: MCP process is not connected. Reconnect to try again.",
    };
    await internal.refreshLocalConnections();
    expect(connection.status).toBe("ready");
    expect(connection.toolSnapshot).toHaveLength(1);
    expect(resumed).toEqual(["connection.tools_changed", "connection.resumed"]);

    expect(paths).toHaveLength(18);
    // Connector-managed credentials still require sign-in, even with authType none.
    state = "error";
    error = "Authentication failed: Slack rejected the saved browser session (invalid_auth). Replace both credentials, then reconnect.";
    await internal.refreshLocalConnections();
    expect(connection.status).toBe("needs_auth");
    expect(connection.statusMessage).toBe(error);
    expect(paths.every((path) => path === `/v1/mcp/connections/${connection.id}`)).toBe(true);
  } finally {
    await service.close();
  }
});

test("a connection the computer could not answer for returns to ready, and a pending sign-in still says it was interrupted", async () => {
  let reachable = true;
  let state = "ready";
  const resumed: string[] = [];
  const make = (status: string, statusMessage: string) => ({
    id: crypto.randomUUID(),
    transport: "stdio",
    status,
    configuration: {},
    statusMessage,
    updatedAt: new Date(),
    toolSnapshot: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] as unknown[],
    installation: { status: "installed" },
  });
  let connections = [
    make("ready", ""),
    make("needs_auth", "Local runtime starting: Complete any browser sign-in prompt. Reconnect to retry."),
    make("error", "Local runtime unavailable: MCP process exited. Reconnect to try again."),
  ];
  const update = (id: string, data: Partial<(typeof connections)[number]>) => {
    connections = connections.map((connection) =>
      connection.id === id
        ? { ...connection, ...data, updatedAt: new Date(connection.updatedAt.getTime() + 1) }
        : connection
    );
  };
  const prisma = {
    pluginConnection: {
      findMany: async () => structuredClone(connections),
      findUnique: async ({ where }: { where: { id: string } }) =>
        structuredClone(connections.find((connection) => connection.id === where.id)),
      updateMany: async ({ where, data }: { where: { id: string }; data: Partial<(typeof connections)[number]> }) => {
        update(where.id, data);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const service = new PluginService(prisma, async () => {
    if (!reachable) throw new Error("getaddrinfo ENOTFOUND computer");
    return Response.json({ state, tools: state === "ready" ? connections[0]!.toolSnapshot : [] });
  });
  const internal = service as unknown as {
    refreshLocalConnections(): Promise<void>;
    markReady(connection: { id: string }, tools: unknown[], kind?: string): Promise<void>;
  };
  internal.markReady = async (connection, tools, kind) => {
    resumed.push(kind ?? "connection.ready");
    update(connection.id, { status: "ready", statusMessage: "", toolSnapshot: tools });
  };
  try {
    // Only the computer restarts; the server keeps checking.
    reachable = false;
    for (let i = 0; i < 3; i++) await internal.refreshLocalConnections();
    const [working, signingIn, failed] = connections;
    expect(working!.status).toBe("error");
    expect(working!.statusMessage).toContain("The computer is not reachable");
    expect(signingIn!.status).toBe("needs_auth");
    expect(failed!.statusMessage).toBe("Local runtime unavailable: MCP process exited. Reconnect to try again.");

    // The computer is back and its processes are stopped until their next call.
    reachable = true;
    state = "stopped";
    for (let i = 0; i < 3; i++) await internal.refreshLocalConnections();
    const [back, interrupted, stillFailed] = connections;
    expect(back!.status).toBe("ready");
    expect(back!.toolSnapshot).toHaveLength(1);
    expect(resumed).toEqual(["connection.resumed"]);
    expect(interrupted!.status).toBe("error");
    expect(interrupted!.statusMessage).toContain("Sign-in was interrupted");
    expect(stillFailed!.statusMessage).toBe("Local runtime unavailable: MCP process exited. Reconnect to try again.");
  } finally {
    await service.close();
  }
});
