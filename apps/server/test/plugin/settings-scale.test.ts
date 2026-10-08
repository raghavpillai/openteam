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
  test("initial settings use bounded installation and activity projections", async () => {
    const service = withoutMarketplace({
      pluginInstallation: { findMany: async () => [] },
      pluginActivity: { findMany: async () => [] },
      processSecret: { findMany: async () => [] },
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
      activity: [],
    });
  });

  test("status polling uses one bounded query without package files or artwork", async () => {
    const calls: string[] = [];
    const service = withoutMarketplace({
      $queryRaw: async (query: { sql: string; values: unknown[] }) => {
        calls.push("poll");
        expect(query.values).toEqual(["connection-1"]);
        expect(query.sql).toContain("jsonb_build_object");
        expect(query.sql).not.toContain('i."manifest" AS');
        expect(query.sql).not.toContain("binaryFiles");
        return [
          {
            id: "connection-1",
            connectorKey: "fixture",
            authType: "none",
            status: "needs_auth",
            statusMessage: "Waiting for authentication",
            configuration: {},
            credentials: {},
            toolSnapshot: [],
            updatedAt: new Date("2026-08-31T12:00:00.000Z"),
            manifest: {},
          },
        ];
      },
    });
    const result = await Effect.runPromise(
      service.pollConnectionStatuses(["connection-1", "connection-1"])
    );
    expect(calls).toEqual(["poll"]);
    expect(result).toEqual({
      connections: [
        {
          id: "connection-1",
          revision: "2026-08-31T12:00:00.000Z",
          status: "needs_auth",
          statusMessage: "Waiting for authentication",
          authorizationUrl: null,
          authorizationExpiresAt: null,
          oauthCallbackMode: "manual",
          setupPhase: "ready_to_connect",
          configured: true,
          tools: [],
        },
      ],
    });
  });

  test("status polling skips empty work and caps defensive direct callers", async () => {
    let query: { values: unknown[] } | undefined;
    const service = withoutMarketplace({
      $queryRaw: async (args: typeof query) => {
        query = args;
        return [];
      },
    });
    expect(await Effect.runPromise(service.pollConnectionStatuses([]))).toEqual({
      connections: [],
    });
    expect(query).toBeUndefined();
    await Effect.runPromise(
      service.pollConnectionStatuses(
        Array.from(
          { length: PLUGIN_CONNECTION_STATUS_MAX_IDS + 10 },
          (_, index) => `connection-${index}`
        )
      )
    );
    expect(query?.values).toHaveLength(PLUGIN_CONNECTION_STATUS_MAX_IDS);
  });

  test("agent-facing status loads installations without Bot access tables", async () => {
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
              _count: { },
              lastCheckedAt: null,
            },
          ];
        },
      },
    });

    const result = (await service.connectionStatuses()) as {
      connections: Array<{ id: string; status: string }>;
    };
    expect(query).toMatchObject({
      include: { installation: {select:{name:true,pluginKey:true}} },
    });
    expect(result.connections[0]).toMatchObject({id:"connection-1",status:"ready"});
  });;
});
