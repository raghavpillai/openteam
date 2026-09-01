import { describe, expect, test } from "bun:test";
import { AGENT_DIRECTORY_DEFAULT_LIMIT } from "@openbot/contracts";
import { AdministrationService } from "../src/services/administration-service";

const serviceWith = (prisma: unknown) =>
  new AdministrationService(
    prisma as never,
    {} as never,
    {} as never,
    "/workspace",
    async () => new Response(),
    {} as never
  );

describe("bounded agent and group directory tools", () => {
  test("resolves an arbitrary active peer by exact id without scanning the roster", async () => {
    const targetId = "5a4f3ce4-eed6-feb0-07d2-4e0fa8f25bc4";
    const calls: Array<Record<string, unknown>> = [];
    const service = serviceWith({
      bot: {
        findMany: async (args: Record<string, unknown>) => {
          calls.push(args);
          return [
            {
              id: targetId,
              name: "  Archive   Researcher  ",
              title: "Research",
              description: "Finds old evidence",
              hiddenFromSidebar: true,
              updatedAt: new Date(0),
            },
          ];
        },
      },
    });

    await expect(service.listAgents("parent-id", { query: targetId, limit: 3 })).resolves.toEqual({
      query: targetId,
      agents: [
        {
          id: targetId,
          name: "Archive Researcher",
          title: "Research",
          description: "Finds old evidence",
          hiddenFromSidebar: true,
        },
      ],
      hasMore: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      where: {
        AND: [
          {
            id: { not: "parent-id" },
            status: "active",
            subagentIdentity: { is: null },
          },
          { OR: [{ id: targetId }, { name: { equals: targetId, mode: "insensitive" } }] },
        ],
      },
      take: 4,
    });
  });

  test("uses a bounded recent query and reports truncation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = serviceWith({
      bot: {
        findMany: async (args: Record<string, unknown>) => {
          calls.push(args);
          return Array.from({ length: AGENT_DIRECTORY_DEFAULT_LIMIT + 1 }, (_, index) => ({
            id: `agent-${index}`,
            name: `Agent ${index}`,
            title: "",
            description: "",
            hiddenFromSidebar: false,
            updatedAt: new Date(index),
          }));
        },
      },
    });

    const result = await service.listAgents("parent-id", {});
    expect(result.agents).toHaveLength(AGENT_DIRECTORY_DEFAULT_LIMIT);
    expect(result.hasMore).toBe(true);
    expect(calls[0]).toMatchObject({ take: AGENT_DIRECTORY_DEFAULT_LIMIT + 1 });
  });

  test("returns only joined groups with bounded member projections", async () => {
    const targetId = "64bcd4d8-c40d-4b8f-b292-99d749b6995c";
    const calls: Array<Record<string, unknown>> = [];
    const service = serviceWith({
      channel: {
        findMany: async (args: Record<string, unknown>) => {
          calls.push(args);
          return [
            {
              id: targetId,
              name: "Launch Room",
              description: "Release coordination",
              updatedAt: new Date(0),
              members: [{ botId: "peer-id", bot: { name: "Peer" } }],
            },
          ];
        },
      },
    });

    const result = await service.listGroups("parent-id", { query: targetId, limit: 2 });
    expect(result.groups).toEqual([
      {
        id: targetId,
        name: "Launch Room",
        description: "Release coordination",
        members: [{ id: "peer-id", name: "Peer" }],
      },
    ]);
    expect(calls[0]).toMatchObject({
      where: {
        AND: [
          {
            kind: "group",
            archivedAt: null,
            members: { some: { botId: "parent-id" } },
          },
          { OR: [{ id: targetId }, { name: { equals: targetId, mode: "insensitive" } }] },
        ],
      },
      select: { members: { take: 6 } },
      take: 3,
    });
  });
});
