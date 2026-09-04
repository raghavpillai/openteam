import { describe, expect, test } from "bun:test";
import { PLUGIN_CONNECTION_STATUS_MAX_IDS } from "@openteam/contracts";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";

const withoutMarketplace = (prisma: unknown) => {
  const service = new PluginService(prisma as never);
  Object.assign(service, { catalog: async () => [] });
  return service;
};

describe("bounded plugin settings projections", () => {
  test("initial settings omit Bot and grant fan-out and query only global policies", async () => {
    let policyQuery: unknown;
    const service = withoutMarketplace({
      pluginInstallation: { findMany: async () => [] },
      pluginToolPolicy: {
        findMany: async (args: unknown) => {
          policyQuery = args;
          return [];
        },
      },
      pluginActivity: { findMany: async () => [] },
      bot: {
        count: async () => 1_000,
        findMany: async () => {
          throw new Error("initial plugin settings must not load every Bot");
        },
      },
    });

    const settings = await Effect.runPromise(service.settings());
    expect(settings).toEqual({
      catalog: [],
      installs: [],
      botCount: 1_000,
      policies: [],
      activity: [],
    });
    expect(policyQuery).toMatchObject({ where: { botId: null } });
  });

  test("status polling performs one connection-only query", async () => {
    const calls: string[] = [];
    const service = withoutMarketplace({
      pluginConnection: {
        findMany: async (args: unknown) => {
          calls.push("pluginConnection.findMany");
          expect(args).toMatchObject({
            where: { id: { in: ["connection-1"] } },
            select: {
              id: true,
              status: true,
              statusMessage: true,
              configuration: true,
              credentials: true,
              toolSnapshot: true,
              updatedAt: true,
            },
          });
          return [
            {
              id: "connection-1",
              authType: "none",
              status: "needs_auth",
              statusMessage: "Waiting for authentication",
              configuration: {},
              credentials: {},
              toolSnapshot: [],
              updatedAt: new Date("2026-08-31T12:00:00.000Z"),
            },
          ];
        },
      },
    });

    const result = await Effect.runPromise(
      service.pollConnectionStatuses(["connection-1", "connection-1"])
    );
    expect(calls).toEqual(["pluginConnection.findMany"]);
    expect(result).toEqual({
      connections: [
        {
          id: "connection-1",
          revision: "2026-08-31T12:00:00.000Z",
          status: "needs_auth",
          statusMessage: "Waiting for authentication",
          authorizationUrl: null,
          configured: true,
          tools: [],
        },
      ],
    });
  });

  test("status polling skips empty work and caps defensive direct callers", async () => {
    let query: { where?: { id?: { in?: string[] } } } | undefined;
    const service = withoutMarketplace({
      pluginConnection: {
        findMany: async (args: typeof query) => {
          query = args;
          return [];
        },
      },
    });

    expect(await Effect.runPromise(service.pollConnectionStatuses([]))).toEqual({
      connections: [],
    });
    expect(query).toBeUndefined();

    await Effect.runPromise(
      service.pollConnectionStatuses(
        Array.from({ length: PLUGIN_CONNECTION_STATUS_MAX_IDS + 10 }, (_, index) =>
          ["connection", index].join("-")
        )
      )
    );
    expect(query?.where?.id?.in).toHaveLength(PLUGIN_CONNECTION_STATUS_MAX_IDS);
  });

  test("agent-facing status counts grants in SQL instead of materializing Bot rows", async () => {
    let query: unknown;
    const service = withoutMarketplace({
      pluginConnection: {
        findMany: async (args: unknown) => {
          query = args;
          return [
            {
              id: "connection-1",
              installation: { pluginKey: "audit", name: "Audit" },
              name: "Audit",
              alias: "default",
              status: "ready",
              statusMessage: null,
              toolSnapshot: [],
              _count: { grants: 1_000 },
              lastCheckedAt: null,
            },
          ];
        },
      },
    });

    const result = (await service.connectionStatuses()) as {
      connections: Array<{ grantedBotCount: number }>;
    };
    expect(query).toMatchObject({
      include: { _count: { select: { grants: { where: { enabled: true } } } } },
    });
    expect(result.connections[0]?.grantedBotCount).toBe(1_000);
  });

  test("Bot access searches all 1,000 Bots but materializes only one 60-row page", async () => {
    const queries: Record<string, unknown> = {};
    const bots = Array.from({ length: 60 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Audit Bot ${index}`,
      icon: "●",
      color: "#4f7cff",
    }));
    const service = withoutMarketplace({
      pluginInstallation: {
        findUnique: async (args: unknown) => {
          queries.installation = args;
          return { id: "installation-1" };
        },
      },
      bot: {
        count: async (args: unknown) => {
          queries.count = args;
          return 1_000;
        },
        findMany: async (args: unknown) => {
          queries.bots = args;
          return bots;
        },
      },
      botPluginConnectionGrant: {
        findMany: async (args: unknown) => {
          queries.grants = args;
          return [{ botId: "bot-0", connectionId: "connection-1" }];
        },
      },
      botPluginEnablement: {
        findMany: async (args: unknown) => {
          queries.enablements = args;
          return [{ botId: "bot-1" }];
        },
      },
    });

    const result = await Effect.runPromise(service.botAccess("audit", "  Audit   Bot  ", 0, 500));
    expect(result.query).toBe("Audit Bot");
    expect(result.total).toBe(1_000);
    expect(result.bots).toHaveLength(60);
    expect(result.bots[0]).toMatchObject({
      id: "bot-0",
      skillsEnabled: false,
      grantedConnectionIds: ["connection-1"],
    });
    expect(result.bots[1]).toMatchObject({
      id: "bot-1",
      skillsEnabled: true,
      grantedConnectionIds: [],
    });
    expect(queries.bots).toMatchObject({
      where: { status: { not: "archived" }, name: { contains: "Audit Bot", mode: "insensitive" } },
      skip: 0,
      take: 60,
    });
    expect(queries.grants).toMatchObject({
      where: {
        botId: { in: bots.map((bot) => bot.id) },
        enabled: true,
        connection: { installationId: "installation-1" },
      },
    });
    expect(queries.enablements).toMatchObject({
      where: { botId: { in: bots.map((bot) => bot.id) }, installationId: "installation-1" },
    });
  });
});
