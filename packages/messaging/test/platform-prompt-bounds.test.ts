import { preparePromptSections } from "../src/prompt-sections";
import { describe, expect, test } from "bun:test";
import {
  AgentMessaging,
  PLATFORM_PROMPT_GROUP_LIMIT,
  PLATFORM_PROMPT_PEER_LIMIT,
  renderTeammatesUserInfo,
  selectPlatformPromptPeers,
  TEAMMATES_POINTER,
  NO_TEAMMATES_SECTION,
} from "../src";

const peers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `agent-${index.toString().padStart(5, "0")}`,
    name: `Agent ${index}`,
    hiddenFromSidebar: index % 3 === 0,
  }));

describe("bounded teammates roster", () => {
  test("keeps the roster bounded at 1k and 10k bots", () => {
    const measurements = [100, 1_000, 10_000].map((count) => {
      const roster = peers(count);
      const selected = selectPlatformPromptPeers([], roster);
      const bounded = renderTeammatesUserInfo({ peers: selected, groups: [], agentsRoot: "/agent-data/agents", morePeers: true })!;
      return {
        count,
        boundedBytes: Buffer.byteLength(bounded),
        bounded,
      };
    });

    expect(measurements[1]?.boundedBytes).toBe(measurements[2]?.boundedBytes);
    expect(measurements[1]?.bounded).toBe(measurements[2]?.bounded);
    expect(measurements[2]?.boundedBytes).toBeLessThan(4_000);
    expect(measurements[2]?.bounded).toContain("\u2026and more (read the agent folders above for the full roster).");
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
      ...peers(PLATFORM_PROMPT_PEER_LIMIT * 2),
    ];
    const selected = selectPlatformPromptPeers(related, recent);
    expect(selected.slice(0, 2).map(({ id }) => id)).toEqual(["related-1", "related-2"]);
    expect(new Set(selected.map(({ id }) => id)).size).toBe(selected.length);
    expect(selected).toHaveLength(PLATFORM_PROMPT_PEER_LIMIT);
  });

  test("renders teammates and group chats in id order, with descriptions and members", () => {
    const block = renderTeammatesUserInfo({
      peers: [
        { id: "b-agent", name: "Researcher", description: "Finds  sources\nfast", hiddenFromSidebar: false },
        { id: "a-agent", name: "Archivist", hiddenFromSidebar: true },
      ],
      groups: [{ id: "g-1", name: "Launch", workingDirectory: "/workspace/launch", members: [{ bot: { name: "Researcher" } }] }],
      agentsRoot: "/agent-data/agents",
    })!;
    expect(block.split("\n")).toEqual([
      "<teammates>",
      'Each teammate is its own assistant with its own chat, persona, and memory, and the user may not know you can reach them. When looping one in would genuinely help, offer it ("want me to ask @Name?"), and treat "@ that agent", "tell my other agent\u2026", or "ask the group" as a request to send. Writing @ and a teammate\'s exact name in your private chat does not reach the teammate; use SendToAgent.',
      expect.stringContaining("Every agent (yours included) is a sibling folder under /agent-data/agents."),
      "Teammates you can message right now:",
      "- Archivist (id: a-agent) (hidden from the user's sidebar, but reachable)",
      "- Researcher (id: b-agent): Finds sources fast",
      "Group chats (channels) you're in (post to one by its id to reach all its members):",
      "- Launch (id: g-1): with Researcher (project folder: /workspace/launch)",
      "</teammates>",
    ]);
    expect(renderTeammatesUserInfo({ peers: [], groups: [], agentsRoot: "/agent-data/agents" })).toBeNull();
  });

  test("applies SQL limits before materialization and points the prompt at the roster", async () => {
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
        preparePlatformSections: async (_bot: string, _context: string, epoch: number, live: Record<string, string>) => preparePromptSections({}, epoch, live),
        promptContext: async () => ({
          compactionEpoch: 0,
          profileSection: "You are Main.",
          profileSnapshot: null,
          identityAnnouncement: "",
          memory: { policy: "## Memory\nMemory policy.", facts: "No facts recorded yet." },
          skillRender: '<agent_skill fullPath="/agent-data/workflows/x/SKILL.md">X</agent_skill>',
          warnings: [],
        }),
        loadInferenceSettings: async () => ({
          providerId: "openai-codex",
          modelId: "gpt-5.5",
          reasoning: "high",
        }),
        loadTaskConfiguration: async () => ({ executorProfiles: [] }),
      },
      prisma: {
        $queryRaw: async () => [],
        contextSession: { findMany: async () => [] },
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
    expect(prompt.instructions).toContain(`## Teammates and groups\n${TEAMMATES_POINTER}`);
    expect(prompt.instructions).not.toContain(NO_TEAMMATES_SECTION);
    expect(prompt.userInfo).toContain("- Related Peer (id: related-peer)");
    expect(prompt.userInfo).toContain("Teammates you can message right now:");
    expect(prompt.userInfo).toContain("\u2026and more (read the agent folders above for the full roster).");
    expect(prompt.userInfo).not.toContain(`Group ${PLATFORM_PROMPT_GROUP_LIMIT} (`);
    expect(prompt.userInfo!.indexOf("<teammates>")).toBeLessThan(prompt.userInfo!.indexOf("<agent_skills>"));
  });
});
