import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, type MemoryInferenceRequest } from "../src/agent-data";
import { readMemoryTree } from "../src/memory-files";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
interface Fixture {
  store: AgentDataStore;
  legacy: AgentDataStore;
  botId: string;
  root: string;
  reports: () => Promise<unknown[]>;
}

async function withStore(
  infer: (request: MemoryInferenceRequest, fixture: Fixture) => Promise<string>,
  run: (fixture: Fixture) => Promise<void>
) {
  const prisma = createPrismaClient(databaseUrl!);
  const temporary = await mkdtemp(join(tmpdir(), "memory-recovery-"));
  const botId = crypto.randomUUID();
  let fixture: Fixture;
  const store = new AgentDataStore(prisma, {
    root: join(temporary, "agent-data"),
    workspaceRoot: temporary,
    memoryDreamingEnabled: true,
    memorySynthesisDebounceMs: 60_000,
    memoryInference: (request) => infer(request, fixture),
  });
  const legacy = new AgentDataStore(prisma, {
    root: store.root,
    workspaceRoot: temporary,
    memoryDreamingEnabled: false,
  });
  fixture = { store, legacy, botId, root: store.memoryDirectory(botId, "agent"), reports: async()=> (await prisma.event.findMany({where:{topic:"memory.synthesis_report",entityId:botId},orderBy:{sequence:"asc"}})).map(event=>event.payload) };
  try {
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Recovery fixture",
        status: "active",
        onboardingStatus: "completed",
        defaultDirectory: temporary,
      },
    });
    await store.initializeBot(botId);
    await run(fixture);
  } finally {
    await store.stopMemoryLifecycle();
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
}

databaseTest(
  "spool overflow uses the newest 12 once and cleans the older files instead of replaying them",
  async () => {
    const inputs: Array<Array<{ occurredAt: number }>> = [];
    await withStore(
      async (request) => {
        expect(request.kind).toBe("synthesis");
        inputs.push(JSON.parse(request.prompt).newEvidence);
        return '{"changes":[]}';
      },
      async ({ store, root, reports }) => {
        const spool = join(root, ".dreaming", "evidence");
        await mkdir(spool, { recursive: true });
        for (let index = 0; index < 20; index++) {
          const id = `123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}`;
          await writeFile(
            join(spool, `${id}.json`),
            JSON.stringify({
              id,
              occurredAt: index,
              user: `Evidence ${index}`,
              assistant: "Acknowledged",
            })
          );
        }
        await store.startMemoryLifecycle();
        await store.runMemorySynthesisNow();
        await store.runMemorySynthesisNow();
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.map(({ occurredAt }) => occurredAt)).toEqual(
          Array.from({ length: 12 }, (_, i) => i + 8)
        );
        expect(await readdir(spool)).toEqual([]);
        const outcomes=await reports();
        expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({outcome:"evidence_dropped",evidenceCount:8,reason:"spool_overflow"}),expect.objectContaining({outcome:"unchanged",evidenceCount:12,changeCount:0})]));
        expect(JSON.stringify(outcomes)).not.toContain("Acknowledged");
      }
    );
  }
);

databaseTest(
  "a stale synthesis snapshot retains evidence and retries against the current files",
  async () => {
    const evidenceIds: string[][] = [];
    await withStore(
      async (request, { legacy, botId }) => {
        if (request.kind === "verification") return '{"approved":true}';
        const input = JSON.parse(request.prompt);
        evidenceIds.push(input.newEvidence.map((item: { id: string }) => item.id));
        if (evidenceIds.length === 1) {
          await legacy.writeMemory(botId, {
            scope: "agent",
            tier: "log",
            fact: "A concurrent user file change survives.",
          });
        } else {
          expect(input.currentMemories.map((item: { content: string }) => item.content)).toContain(
            "A concurrent user file change survives."
          );
        }
        return JSON.stringify({
          changes: [
            {
              action: "create",
              content: "Prefers amber.",
              kind: "profile",
              sourceEvidenceIds: evidenceIds.at(-1),
            },
          ],
        });
      },
      async ({ store, botId, root }) => {
        await store.recordTurnMemory(botId, {
          user: "Please use amber in future reports.",
          assistant: "Understood.",
        });
        await store.runMemorySynthesisNow();
        expect((await readMemoryTree(root)).map(({ content }) => content)).toEqual([
          "A concurrent user file change survives.",
        ]);
        await store.runMemorySynthesisNow();
        expect(evidenceIds).toHaveLength(2);
        expect(evidenceIds[1]).toEqual(evidenceIds[0]);
        expect((await readMemoryTree(root)).map(({ content }) => content)).toEqual([
          "Prefers amber.",
          "A concurrent user file change survives.",
        ]);
        await store.runMemorySynthesisNow();
        expect(evidenceIds).toHaveLength(2);
      }
    );
  }
);

databaseTest("evidence arriving during synthesis stays queued for its own pass", async () => {
  const users: string[][] = [];
  await withStore(
    async (request, { store, botId }) => {
      const input = JSON.parse(request.prompt);
      users.push(input.newEvidence.map((item: { user: string }) => item.user));
      if (users.length === 1) {
        await store.recordTurnMemory(botId, {
          user: "The second exchange.",
          assistant: "Second reply.",
        });
      }
      return '{"changes":[]}';
    },
    async ({ store, botId }) => {
      await store.recordTurnMemory(botId, {
        user: "The first exchange.",
        assistant: "First reply.",
      });
      await store.runMemorySynthesisNow();
      await store.runMemorySynthesisNow();
      await store.runMemorySynthesisNow();
      expect(users).toEqual([["The first exchange."], ["The second exchange."]]);
    }
  );
});

databaseTest(
  "exhausted invalid proposals consume the evidence without editing existing memory",
  async () => {
    let attempts = 0;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withStore(
        async () => {
          attempts++;
          return "invalid JSON";
        },
        async ({ store, legacy, botId, root }) => {
          await legacy.writeMemory(botId, {
            scope: "agent",
            tier: "profile",
            fact: "Keep this existing fact.",
          });
          await store.recordTurnMemory(botId, {
            user: "This is evidence for a failing model.",
            assistant: "Understood.",
          });
          await store.runMemorySynthesisNow();
          await store.runMemorySynthesisNow();
          expect(attempts).toBe(3);
          expect((await readMemoryTree(root)).map(({ content }) => content)).toEqual([
            "Keep this existing fact.",
          ]);
          expect(warning).toHaveBeenCalledTimes(1);
        }
      );
    } finally {
      warning.mockRestore();
    }
  },
  15_000
);

databaseTest("shutdown during verification cannot commit a late approved response", async () => {
  const kinds: string[] = [];
  await withStore(
    async (request, { store }) => {
      kinds.push(request.kind);
      if (request.kind === "verification") {
        await store.stopMemoryLifecycle();
        expect(request.signal?.aborted).toBe(true);
        return '{"approved":true}';
      }
      const input = JSON.parse(request.prompt);
      return JSON.stringify({
        changes: [
          {
            action: "create",
            content: "Must not be committed after shutdown.",
            kind: "log",
            sourceEvidenceIds: [input.newEvidence[0].id],
          },
        ],
      });
    },
    async ({ store, botId, root }) => {
      await store.recordTurnMemory(botId, {
        user: "A request while the worker shuts down.",
        assistant: "Understood.",
      });
      await store.runMemorySynthesisNow();
      expect(kinds).toEqual(["synthesis", "verification"]);
      expect(await readMemoryTree(root)).toEqual([]);
    }
  );
});
