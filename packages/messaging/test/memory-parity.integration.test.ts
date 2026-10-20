import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, type MemoryInferenceRequest } from "../src/agent-data";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;

databaseTest(
  "a turn corrects durable memory and announces the replacement until delivered",
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
      memoryInference: async (request) => {
        requests.push(request);
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

      const longUser = `${"Context ".repeat(300)}I now live in NYC, and cobalt is good for this demo.`;
      await store.recordTurnMemory(botId, {
        user: longUser,
        assistant: "Understood.",
        occurredAt: Date.parse("2026-09-12T10:00:00Z"),
      });
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
      // Changes are a diff: the removed fact must be marked as a deletion.
      expect(changed.update).toMatch(/^-.*Lives in Boston\./m);
      expect(changed.update).toMatch(/^\+.*Lives in NYC\./m);
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

      expect(requests[0]?.prompt).toContain(longUser);

      const facts = await prisma.memoryFact.findMany({ where: { namespace: `agent:${botId}` } });
      expect(facts.map(({ fact }) => fact)).toEqual(
        expect.arrayContaining([
          "Prefers visual explanations.",
          "Lives in NYC.",
          "[note] Likes cobalt for this demo.",
        ])
      );
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
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.$disconnect();
      await rm(temporary, { recursive: true, force: true });
    }
  }
);
