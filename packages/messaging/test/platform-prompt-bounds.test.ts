import { describe, expect, test } from "bun:test";
import {
  AgentMessaging,
  PLATFORM_PROMPT_GROUP_LIMIT,
  PLATFORM_PROMPT_PEER_LIMIT,
  renderPlatformPromptTargetLines,
  selectPlatformPromptPeers,
} from "../src";

const peers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `agent-${index.toString().padStart(5, "0")}`,
    name: `Agent ${index}`,
    hiddenFromSidebar: index % 3 === 0,
  }));

describe("bounded platform target context", () => {
  test("keeps the target prompt constant at 1k and 10k bots while the old catalog grows", () => {
    const measurements = [10, 1_000, 10_000].map((count) => {
      const roster = peers(count);
      const selected = selectPlatformPromptPeers([], roster);
      const bounded = renderPlatformPromptTargetLines(selected, []).join("\n");
      const legacy = roster.map((peer) => `- Agent ${peer.name}: ${peer.id}`).join("\n");
      return {
        count,
        boundedBytes: Buffer.byteLength(bounded),
        legacyBytes: Buffer.byteLength(legacy),
        bounded,
      };
    });

    expect(measurements.map(({ count, legacyBytes }) => ({ count, legacyBytes }))).toEqual([
      { count: 10, legacyBytes: 289 },
      { count: 1_000, legacyBytes: 30_889 },
      { count: 10_000, legacyBytes: 318_889 },
    ]);
    expect(measurements[1]?.boundedBytes).toBe(measurements[2]?.boundedBytes);
    expect(measurements[1]?.bounded).toBe(measurements[2]?.bounded);
    expect(measurements[2]?.boundedBytes).toBeLessThan(1_000);
    expect(selectPlatformPromptPeers([], peers(10_000))).toHaveLength(PLATFORM_PROMPT_PEER_LIMIT);
  });

  test("prioritizes related peers, deduplicates them, then fills from recent peers", () => {
    const related = [
      { id: "related-1", name: "Related 1", hiddenFromSidebar: false },
      { id: "related-2", name: "Related 2", hiddenFromSidebar: false },
      { id: "related-1", name: "Duplicate", hiddenFromSidebar: false },
    ];
    const recent = [
      { id: "related-2", name: "Duplicate recent", hiddenFromSidebar: false },
      ...peers(20),
    ];
    const selected = selectPlatformPromptPeers(related, recent);
    expect(selected.slice(0, 2).map(({ id }) => id)).toEqual(["related-1", "related-2"]);
    expect(new Set(selected.map(({ id }) => id)).size).toBe(selected.length);
    expect(selected).toHaveLength(PLATFORM_PROMPT_PEER_LIMIT);
  });

  test("applies SQL limits before materialization and teaches exact directory discovery", async () => {
    const queryArgs: Record<string, unknown> = {};
    const recent = peers(PLATFORM_PROMPT_PEER_LIMIT + 1);
    const groups = Array.from({ length: PLATFORM_PROMPT_GROUP_LIMIT + 1 }, (_, index) => ({
      id: `group-${index}`,
      name: `Group ${index}`,
      workingDirectory: index === 0 ? "/workspace/project" : null,
      members:
        index === 0
          ? [
              {
                bot: { id: "related-peer", name: "Related Peer", hiddenFromSidebar: false },
              },
            ]
          : [],
    }));
    const messaging = Object.create(AgentMessaging.prototype) as Record<string, unknown>;
    Object.assign(messaging, {
      defaultTimeZone: "UTC",
      agentData: {
        root: "/agent-data",
        promptContext: async () => ({
          compactionEpoch: 0,
          profileSection: "You are Main.",
          profileSnapshot: null,
          identityAnnouncement: "",
          memoryRender: "",
          memorySnapshot: null,
          skillRender: "",
          warnings: [],
        }),
        loadRootSettings: async () => ({
          valid: true,
          settings: {
            inference: {
              providerId: "openai-codex",
              modelId: "gpt-5.5",
              reasoning: "high",
            },
          },
        }),
      },
      prisma: {
        $queryRaw: async () => [],
        bot: {
          findUniqueOrThrow: async (args: Record<string, unknown>) => {
            queryArgs.bot = args;
            return {
              id: "main",
              name: "Main",
              instructions: "",
              hiddenFromSidebar: false,
              notificationsEnabled: true,
              defaultDirectory: "/workspace",
              subagentIdentity: null,
              todos: [],
            };
          },
          findMany: async (args: Record<string, unknown>) => {
            queryArgs.peers = args;
            return recent;
          },
        },
        channel: {
          findMany: async (args: Record<string, unknown>) => {
            queryArgs.groups = args;
            return groups;
          },
        },
        projectMember: { findMany: async () => [] },
        botConnectorState: { findMany: async () => [] },
        routine: { findMany: async () => [] },
      },
    });

    const prompt = await AgentMessaging.prototype.platformPrompt.call(
      messaging as unknown as AgentMessaging,
      "main"
    );
    expect(queryArgs.bot).toMatchObject({ include: { todos: { take: 64 } } });
    expect(queryArgs.peers).toMatchObject({ take: PLATFORM_PROMPT_PEER_LIMIT + 1 });
    expect(queryArgs.groups).toMatchObject({
      take: PLATFORM_PROMPT_GROUP_LIMIT + 1,
      select: { members: { take: 6 } },
    });
    expect(prompt.instructions).toContain("Recent and related SendToAgent targets");
    expect(prompt.instructions).toContain("Agent Related Peer: related-peer");
    expect(prompt.instructions).toContain(
      "Use ListAgents or ListGroups for an exact id/name lookup"
    );
    expect(prompt.instructions).not.toContain(`Group ${PLATFORM_PROMPT_GROUP_LIMIT}:`);
  });
});
