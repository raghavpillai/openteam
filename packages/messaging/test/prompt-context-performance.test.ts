import { describe, expect, test } from "bun:test";
import { AgentDataStore } from "../src/agent-data";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  botId: "bot-1",
  profileEpoch: 7,
  profileSection: "Frozen profile",
  systemName: "Bot",
  systemDescription: "Description",
  announcedName: "Bot",
  announcedDescription: "Description",
  memoryEpoch: 7,
  memoryRender: "Frozen memory",
  memoryHasFacts: true,
  skillEpoch: 7,
  skillRender: "Frozen skills",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const promptStore = (snapshotValue: ReturnType<typeof snapshot>) => {
  const calls = { memory: 0, skills: 0 };
  const prisma = {
    bot: {
      findUniqueOrThrow: async () => ({
        id: "bot-1",
        name: "Bot",
        title: "",
        description: "Description",
        instructions: "",
        conversation: { compactionEpoch: 7 },
        projectMemberships: [],
      }),
    },
    agentPromptSnapshot: {
      findUnique: async () => snapshotValue,
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        ...snapshotValue,
        ...data,
      }),
    },
  };
  const store = new AgentDataStore(prisma as never, {
    root: "/tmp/openbot-prompt-context-test",
    workspaceRoot: "/tmp/openbot-prompt-context-workspace",
  });
  Object.assign(store, {
    reconcileBot: async () => ({ warnings: [] }),
    renderMemory: async () => {
      calls.memory += 1;
      return "Live memory";
    },
    renderSkills: async () => {
      calls.skills += 1;
      return "Live skills";
    },
  });
  return { calls, store };
};

describe("prompt-context frozen epoch fast path", () => {
  test("performs zero live memory and skill queries for an authoritative frozen epoch", async () => {
    const fixture = promptStore(snapshot());
    const context = await fixture.store.promptContext("bot-1");
    expect(fixture.calls).toEqual({ memory: 0, skills: 0 });
    expect(context.memoryRender).toBe("Frozen memory");
    expect(context.skillRender).toBe("Frozen skills");
  });

  test("still checks live memory before the epoch has captured any facts", async () => {
    const fixture = promptStore(snapshot({ memoryHasFacts: false, memoryRender: "" }));
    const context = await fixture.store.promptContext("bot-1");
    expect(fixture.calls).toEqual({ memory: 1, skills: 0 });
    expect(context.memoryRender).toBe("Live memory");
    expect(context.skillRender).toBe("Frozen skills");
  });

  test("limits skill rows in SQL while preserving the exact omitted count", async () => {
    let findArgs: unknown;
    const store = new AgentDataStore(
      {
        savedSkill: {
          findMany: async (args: unknown) => {
            findArgs = args;
            return [
              { name: "One", slug: "one", description: "First" },
              { name: "Two", slug: "two", description: "Second" },
            ];
          },
          count: async () => 104,
        },
      } as never,
      {
        root: "/agent-data",
        workspaceRoot: "/workspace",
      }
    ) as unknown as { renderSkills(botId: string): Promise<string> };

    const rendered = await store.renderSkills("bot-1");
    expect(findArgs).toEqual({ orderBy: { updatedAt: "desc" }, take: 100 });
    expect(rendered).toContain("/agent-data/workflows/one/SKILL.md");
    expect(rendered).toContain("[102 additional skills omitted by the catalog budget]");
  });
});
