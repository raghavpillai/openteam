import { describe, expect, test } from "bun:test";
import { AgentDataStore } from "../src/agent-data";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  contextSessionId: "context-1",
  profileEpoch: 7,
  profileSection: "Frozen profile",
  systemName: "Bot",
  systemDescription: "Description",
  announcedName: "Bot",
  announcedDescription: "Description",
  promptSections: {},
  skillEpoch: 7,
  skillRender: "Frozen skills",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const promptStore = (snapshotValue: ReturnType<typeof snapshot>) => {
  const calls = { memory: 0, skills: 0, updates: [] as Record<string, unknown>[] };
  const prisma = {
    bot: {
      findUniqueOrThrow: async () => ({
        id: "bot-1",
        name: "Bot",
        title: "",
        description: "Description",
        instructions: "",
      }),
    },
    contextSession: { findFirstOrThrow: async () => ({ id: "context-1", botId: "bot-1", compactionEpoch: 7 }) },
    contextPromptSnapshot: {
      findUnique: async () => snapshotValue,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.updates.push(data);
        return { ...snapshotValue, ...data };
      },
    },
  };
  const store = new AgentDataStore(prisma as never, {
    root: "/tmp/openteam-prompt-context-test",
    workspaceRoot: "/tmp/openteam-prompt-context-workspace",
  });
  Object.assign(store, {
    reconcileBot: async () => ({ warnings: [] }),
    renderMemory: async () => {
      calls.memory += 1;
      return { policy: "Memory policy", facts: "Live facts" };
    },
    renderSkills: async () => {
      calls.skills += 1;
      return "Live skills";
    },
  });
  return { calls, store };
};

describe("prompt-context frozen epoch fast path", () => {
  test("renders live memory for the facts pin while retaining the frozen skill prefix", async () => {
    const fixture = promptStore(snapshot());
    const context = await fixture.store.promptContext("bot-1", "context-1");
    expect(fixture.calls).toEqual({ memory: 1, skills: 0, updates: [] });
    expect(context.memory).toEqual({ policy: "Memory policy", facts: "Live facts" });
    expect(context.skillRender).toBe("Frozen skills");
  });

  test("existing frozen sessions receive installed skills without resetting the user workflow snapshot", async () => {
    const fixture = promptStore(snapshot({skillRender: ""}));
    Object.assign(fixture.store, { renderManagedSkills: async () => "- Routines: /installed/routines/SKILL.md" });
    expect((await fixture.store.promptContext("bot-1", "context-1")).skillRender).toContain("/installed/routines/SKILL.md");
    expect(fixture.calls.skills).toBe(0);
    Object.assign(fixture.store, { renderManagedSkills: async () => "" });
    expect((await fixture.store.promptContext("bot-1", "context-1")).skillRender).toBe("");
  });

  test("limits skill rows in SQL while preserving the exact omitted count", async () => {
    let findArgs: unknown;
    const store = new AgentDataStore(
      {
        savedSkill: {
          findMany: async (args: unknown) => {
            findArgs = args;
            return Array.from({ length: 103 }, (_, i) => ({ name: `Skill ${i}`, slug: i ? `s${i}` : "one", description: `Skill ${i}` }));
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
    // Five past the cap are fetched so the notice can name the omitted skills' folders, as the reference's does.
    expect(findArgs).toEqual({ orderBy: { updatedAt: "desc" }, take: 105 });
    expect(rendered).toContain("/agent-data/workflows/one/SKILL.md");
    expect(rendered).toContain("/agent-data/workflows/s99/SKILL.md");
    expect(rendered).not.toContain("/agent-data/workflows/s100/SKILL.md");
    expect(rendered).toEndWith("\n\nAdditional skills omitted from this initial list (4). Directories containing omitted skills: /agent-data/workflows/s100, /agent-data/workflows/s101, /agent-data/workflows/s102.");
  });
});
