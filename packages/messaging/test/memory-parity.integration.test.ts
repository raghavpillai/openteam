import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, type MemoryInferenceRequest } from "../src/agent-data";
import { readMemoryTree, memoryOrigin } from "../src/memory-files";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;

databaseTest(
  "a turn corrects durable memory, announces the replacement until delivered, and preserves full episode evidence",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const temporary = await mkdtemp(join(tmpdir(), "memory-parity-integration-"));
    const workspace = join(temporary, "workspace");
    const botId = crypto.randomUUID();
    const contextId = crypto.randomUUID();
    const requests: MemoryInferenceRequest[] = [];
    const store = new AgentDataStore(prisma, {
      root: join(temporary, "agent-data"),
      workspaceRoot: workspace,
      memoryEpisodeInterval: 2,
      memoryInference: async (request) => {
        requests.push(request);
        if (request.kind === "episode")
          return "On September 12, 2026, moved to NYC and chose cobalt for the demo.";
        if (requests.filter(({ kind }) => kind === "extraction").length === 1) {
          expect(request.prompt).toContain("Lives in Boston.");
          expect(request.prompt).toContain("Prefers visual explanations.");
          return "remove: Lives in Boston.\nremove: Invented old fact.\nprofile: Lives in NYC.\nnote: Likes cobalt for this demo.";
        }
        return "NONE";
      },
    });
    try {
      await mkdir(workspace, { recursive: true });
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Memory parity",
          status: "active",
          onboardingStatus: "completed",
          defaultDirectory: workspace,
          contextSessions: { create: { id: contextId, scope: "home", scopeId: botId } },
        },
      });
      await store.initializeBot(botId);
      for (const fact of ["Lives in Boston.", "Prefers visual explanations."]) {
        await store.writeMemory(botId, {
          scope: "agent",
          tier: "profile",
          fact,
          at: new Date("2020-01-01"),
        });
      }
      const first = await store.promptContext(botId, contextId);
      await store.preparePlatformSections(botId, contextId, first.compactionEpoch, {
        memory: first.liveMemoryRender!,
      });

      // Neither hidden work nor lightweight acknowledgements enters the legacy learner.
      await store.recordTurnMemory(botId, { user: "Thanks...]", assistant: "You're welcome." });
      await store.recordTurnMemory(botId, {
        user: "A hidden request must not become memory.",
        assistant: "Done",
        hidden: true,
      });
      expect(requests).toHaveLength(0);
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).episodePending).toBe(0);

      const longUser = `${"Context ".repeat(300)}I now live in NYC, and cobalt is good for this demo.`;
      await store.recordTurnMemory(botId, {
        user: longUser,
        assistant: "Understood.",
        occurredAt: Date.parse("2026-09-12T10:00:00Z"),
      });
      const pending = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      expect(pending.episodePending).toBe(1);
      expect(pending.episodeTurns).toEqual([
        { ts: Date.parse("2026-09-12T10:00:00Z"), user: longUser, agent: "Understood." },
      ]);
      const current = await store.promptContext(botId, contextId);
      expect(current.memoryRender).toBe(first.memoryRender);
      expect(current.liveMemoryRender).toContain("Lives in NYC.");
      expect(current.liveMemoryRender).not.toContain("Lives in Boston.");
      expect(await store.recallMemory(botId, { query: "Lives", scope: "agent" })).toContain(
        "Lives in NYC."
      );

      const changed = await store.preparePlatformSections(
        botId,
        contextId,
        current.compactionEpoch,
        { memory: current.liveMemoryRender! }
      );
      expect(changed.sections.memory).toBe(first.liveMemoryRender);
      expect(changed.update).toContain("Lives in NYC.");
      expect(changed.update).not.toContain("Lives in Boston.");
      const undelivered = await store.preparePlatformSections(
        botId,
        contextId,
        current.compactionEpoch,
        { memory: current.liveMemoryRender! }
      );
      expect(undelivered.update).toBe(changed.update);
      await store.acknowledgePlatformSections(botId, contextId, changed.receipts);
      expect(
        (
          await store.preparePlatformSections(botId, contextId, current.compactionEpoch, {
            memory: current.liveMemoryRender!,
          })
        ).update
      ).toBeNull();

      await store.recordTurnMemory(botId, {
        user: "The decision is final for the demo.",
        assistant: "Recorded.",
        occurredAt: Date.parse("2026-09-12T11:00:00Z"),
      });
      expect(requests.filter(({ kind }) => kind === "episode")).toHaveLength(1);
      expect(requests.find(({ kind }) => kind === "episode")?.prompt).toContain(longUser);
      const after = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      expect(after.episodePending).toBe(0);
      expect(after.episodeTurns).toEqual([]);

      const root = store.memoryDirectory(botId, "agent");
      const facts = await readMemoryTree(root);
      expect(facts.map(({ content }) => content)).toEqual(
        expect.arrayContaining([
          "Prefers visual explanations.",
          "Lives in NYC.",
          "[note] Likes cobalt for this demo.",
          "[episode] On September 12, 2026, moved to NYC and chose cobalt for the demo.",
        ])
      );
      expect(
        await memoryOrigin(
          root,
          facts.find(({ content }) => content === "Lives in NYC.")!.logicalId
        )
      ).toBe("legacy");
      const restarted = new AgentDataStore(prisma, { root: store.root, workspaceRoot: workspace });
      expect(await restarted.recallMemory(botId, { query: "cobalt" })).toContain(
        "[note] Likes cobalt"
      );
      await prisma.contextSession.update({
        where: { id: contextId },
        data: { compactionEpoch: 1 },
      });
      const refreshed = await restarted.promptContext(botId, contextId);
      expect(refreshed.memoryRender).toContain("Lives in NYC.");
      expect(refreshed.memoryRender).not.toContain("Lives in Boston.");
    } finally {
      await store.stopMemoryLifecycle();
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.$disconnect();
      await rm(temporary, { recursive: true, force: true });
    }
  }
);

databaseTest(
  "dreaming protects a fact explicitly re-saved while the proposal is running",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const temporary = await mkdtemp(join(tmpdir(), "memory-dreaming-race-"));
    const botId = crypto.randomUUID();
    let protectedId = "";
    let explicitStore: AgentDataStore;
    const kinds: string[] = [];
    const store = new AgentDataStore(prisma, {
      root: join(temporary, "agent-data"),
      workspaceRoot: temporary,
      memoryDreamingEnabled: true,
      memorySynthesisDebounceMs: 60_000,
      memoryInference: async (request) => {
        kinds.push(request.kind);
        if (request.kind === "verification") return '{"approved":true}';
        const input = JSON.parse(request.prompt);
        expect(
          input.currentMemories.find((fact: { id: string }) => fact.id === protectedId).origin
        ).toBe("legacy");
        await explicitStore.writeMemory(botId, {
          scope: "agent",
          tier: "profile",
          fact: "Prefers exact totals.",
        });
        return JSON.stringify({
          changes: [
            { action: "remove", id: protectedId, sourceEvidenceIds: [input.newEvidence[0].id] },
          ],
        });
      },
    });
    explicitStore = new AgentDataStore(prisma, {
      root: store.root,
      workspaceRoot: temporary,
      memoryDreamingEnabled: true,
    });
    const legacy = new AgentDataStore(prisma, {
      root: store.root,
      workspaceRoot: temporary,
      memoryDreamingEnabled: false,
    });
    try {
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Memory protection",
          status: "active",
          onboardingStatus: "completed",
          defaultDirectory: temporary,
        },
      });
      await store.initializeBot(botId);
      protectedId = (
        await legacy.writeMemory(botId, {
          scope: "agent",
          tier: "profile",
          fact: "Prefers exact totals.",
        })
      ).logicalId;
      await store.recordTurnMemory(botId, {
        user: "Maybe use rounded totals for this chart.",
        assistant: "Let us check.",
      });
      await store.runMemorySynthesisNow();
      expect(kinds).toEqual(["synthesis", "verification"]);
      expect(
        (await readMemoryTree(store.memoryDirectory(botId, "agent"))).map(({ content }) => content)
      ).toEqual(["Prefers exact totals."]);
      expect(await memoryOrigin(store.memoryDirectory(botId, "agent"), protectedId)).toBe(
        "explicit"
      );
      await store.runMemorySynthesisNow();
      expect(kinds).toHaveLength(2);
    } finally {
      await store.stopMemoryLifecycle();
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.$disconnect();
      await rm(temporary, { recursive: true, force: true });
    }
  }
);
