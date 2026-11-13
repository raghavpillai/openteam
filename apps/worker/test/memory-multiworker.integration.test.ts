import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("two worker processes serialize each bot's review backlog and recover a killed owner after the real lease TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-multiworker-"));
  const db = createPrismaClient(databaseUrl!);
  const bots: Array<{ id: string; conversationId: string; channelId: string }> = [];
  const runs: Array<{ id: string; bot: number; turn: number; marker: string; fact: string }> = [];
  const processes: Array<{ token: string; child: ReturnType<typeof Bun.spawn> }> = [];
  const requests: Array<{ owner: string; bot: number; turn: number; runId: string; prompt: string; outcome: "running" | "completed" | "aborted" }> = [];
  const active = new Map<number, number>(), maximum = new Map<number, number>();
  let maximumAcrossBots = 0;
  const fixtureErrors: string[] = [];
  const audit = `memory_review_ack_${crypto.randomUUID().replaceAll("-", "")}`;
  const environmentKeys = ["DATABASE_URL", "OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
  const previous = new Map(environmentKeys.map(key => [key, process.env[key]]));
  let auditCreated = false;
  const computer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request, server) {
    server.timeout(request, 0);
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
    if (path === "/v1/agent-stores" && request.method === "GET") return Response.json({ agents: [] });
    if (path === "/v1/directories") {
      const input = await request.json() as { paths: string[] };
      for (const directory of input.paths ?? []) await mkdir(directory, { recursive: true });
      return Response.json({ directories: input.paths });
    }
    if (path !== "/v1/infer") return Response.json({ ok: true, quarantined: [] });
    const input = await request.json() as { kind: string; prompt: string };
    if (input.kind !== "extraction") return Response.json({ text: "NONE" });
    const latest = input.prompt.split("Latest exchange:\nUser: ").at(-1) ?? "";
    const match = /MWBOT-(\d+)-TURN-(\d+)/.exec(latest);
    const run = match && runs.find(run => run.bot === Number(match[1]) && run.turn === Number(match[2]));
    if (!run) { fixtureErrors.push("Inference did not identify a seeded exchange"); return Response.json({ error: "Unknown exchange" }, { status: 500 }); }
    const owner = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "unknown";
    const entry = { owner, bot: run.bot, turn: run.turn, runId: run.id, prompt: input.prompt, outcome: "running" as "running" | "completed" | "aborted" };
    requests.push(entry);
    const concurrency = (active.get(run.bot) ?? 0) + 1;
    active.set(run.bot, concurrency); maximum.set(run.bot, Math.max(maximum.get(run.bot) ?? 0, concurrency));
    maximumAcrossBots = Math.max(maximumAcrossBots, [...active.values()].reduce((sum, count) => sum + count, 0));
    try {
      const firstCrashAttempt = run.turn === 3 && requests.filter(request => request.runId === run.id).length === 1;
      const aborted = await new Promise<boolean>(resolve => {
        const finish = () => { if (timer) clearTimeout(timer); resolve(true); };
        const timer = firstCrashAttempt ? undefined : setTimeout(() => { request.signal.removeEventListener("abort", finish); resolve(false); }, 300);
        if (request.signal.aborted) finish(); else request.signal.addEventListener("abort", finish, { once: true });
      });
      if (aborted) { entry.outcome = "aborted"; return new Response(null, { status: 499 }); }
      entry.outcome = "completed";
      return Response.json({ text: `profile: ${run.fact}` });
    } finally { active.set(run.bot, (active.get(run.bot) ?? 1) - 1); }
  } });
  const until = async (check: () => Promise<boolean>, timeoutMs = 90_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (fixtureErrors.length) throw new Error(fixtureErrors.join("; "));
      if (await check()) return;
      await Bun.sleep(50);
    }
    const logs = await Promise.all(processes.map(async process => `${process.token}: ${await Bun.file(join(root, `${process.token}.err`)).text().catch(() => "")}`));
    throw new Error(`Multiworker fixture timed out: ${JSON.stringify({ requests, logs })}`);
  };
  const start = async (token: string) => {
    const ready = join(root, `${token}.ready`);
    const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "memory-restart-worker.ts")], {
      env: { ...process.env, OPENTEAM_CONTROL_TOKEN: token, MEMORY_WORKER_READY: ready },
      stdout: Bun.file(join(root, `${token}.out`)), stderr: Bun.file(join(root, `${token}.err`)),
    });
    processes.push({ token, child });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Worker ${token} exited: ${await Bun.file(join(root, `${token}.err`)).text()}`);
      return Bun.file(ready).exists();
    });
    return child;
  };
  const seed = async (botIndex: number, turn: number) => {
    const bot = bots[botIndex]!;
    const id = crypto.randomUUID(), messageId = crypto.randomUUID(), clientId = crypto.randomUUID();
    const marker = `MWBOT-${botIndex}-TURN-${turn}`;
    const content = `For future conversations, remember my durable synthetic code ${marker}.`;
    const fact = `The user's durable synthetic code ${marker} belongs to this memory test.`;
    const completedAt = new Date(Date.now() - 60_000 + turn * 1_000);
    const revision = await db.bot.findUniqueOrThrow({ where: { id: bot.id }, select: { memoryRevision: true } });
    const shared = await db.memoryRevision.findUnique({ where: { scope: "user" } });
    await db.$transaction(async tx => {
      await tx.run.create({ data: { id, botId: bot.id, conversationId: bot.conversationId, channelId: bot.channelId,
        userMessageId: messageId, status: "completed", origin: "user", completedAt, memoryReviewPending: true,
        memoryReviewRevision: revision.memoryRevision + (shared?.revision ?? 0) } });
      await tx.message.create({ data: { id: messageId, botId: bot.id, conversationId: bot.conversationId, runId: id, clientId, role: "user", content, status: "completed", createdAt: completedAt } });
      await tx.inboxEvent.create({ data: { botId: bot.id, conversationId: bot.conversationId, runId: id,
        idempotencyKey: clientId, type: "user.message", payload: { clientId, channelId: bot.channelId, content, messageId }, status: "completed", completedAt } });
      await tx.channelMessage.create({ data: { channelId: bot.channelId, sender: "user", clientId, content, createdAt: completedAt } });
      await tx.channelMessage.create({ data: { channelId: bot.channelId, sender: "agent", senderBotId: bot.id, sourceRunId: id, content: `Recorded ${marker}.`, createdAt: completedAt } });
    });
    const run = { id, bot: botIndex, turn, marker, fact }; runs.push(run); return run;
  };
  try {
    Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_COMPUTER_URL: computer.url.origin,
      OPENTEAM_CONTROL_TOKEN: "multiworker-parent", OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
    const store = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
    await store.writeInferenceSettings({ providerId: "openai-codex", modelId: "controlled-multiworker", reasoning: "low" });
    for (let index = 0; index < 3; index++) {
      const bot = await db.bot.create({ data: { name: `Synthetic memory worker ${index}`, status: "active", onboardingStatus: "completed", defaultDirectory: root, conversation: { create: {} } }, include: { conversation: true } });
      const channel = await db.channel.create({ data: { kind: "bot_dm", directKey: `bot:${bot.id}`, name: bot.name, members: { create: { botId: bot.id, ordinal: 0 } } } });
      bots.push({ id: bot.id, conversationId: bot.conversation!.id, channelId: channel.id });
      for (let turn = 0; turn < 3; turn++) await seed(index, turn);
    }
    // Test-owned audit observes the actual durable true→false acknowledgement,
    // rather than inferring acknowledgement from a deduplicated fact insert.
    await db.$executeRawUnsafe(`CREATE TABLE "${audit}" (sequence bigserial PRIMARY KEY, "runId" uuid NOT NULL)`);
    auditCreated = true;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${audit}_fn"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "${audit}" ("runId") VALUES (NEW.id); RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${audit}_trigger" AFTER UPDATE OF "memoryReviewPending" ON "Run" FOR EACH ROW WHEN (OLD."memoryReviewPending" AND NOT NEW."memoryReviewPending") EXECUTE FUNCTION "${audit}_fn"()`);
    const [workerA, workerB] = await Promise.all([start("memory-worker-a"), start("memory-worker-b")]);
    expect(workerA.pid).not.toBe(workerB.pid);
    await until(async () => await db.run.count({ where: { botId: { in: bots.map(bot => bot.id) }, memoryReviewPending: true } }) === 0);
    expect(requests).toHaveLength(9);
    expect(requests.every(request => request.outcome === "completed")).toBe(true);
    for (let bot = 0; bot < bots.length; bot++) {
      expect(maximum.get(bot)).toBe(1);
      expect(requests.filter(request => request.bot === bot).map(request => request.turn)).toEqual([0, 1, 2]);
      for (let turn = 1; turn < 3; turn++) {
        expect(requests.find(request => request.bot === bot && request.turn === turn)!.prompt).toContain(runs.find(run => run.bot === bot && run.turn === turn - 1)!.fact);
      }
    }
    expect(Math.max(...maximum.values())).toBe(1);
    expect(maximumAcrossBots).toBeGreaterThanOrEqual(2);

    const interrupted = await seed(0, 3);
    await until(async () => requests.some(request => request.runId === interrupted.id && request.outcome === "running"));
    const attempt = requests.find(request => request.runId === interrupted.id)!;
    const owner = processes.find(process => process.token === attempt.owner)!;
    const survivor = processes.find(process => process.token !== attempt.owner)!;
    expect(owner).toBeDefined(); expect(survivor.child.exitCode).toBeNull();
    owner.child.kill("SIGKILL"); await owner.child.exited;
    await until(async () => attempt.outcome === "aborted");
    const [lease] = await db.$queryRaw<Array<{ ownerId: string; expiresAt: Date; remainingMs: number }>>`
      SELECT "ownerId", "expiresAt", (EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp())) * 1000)::float8 AS "remainingMs"
      FROM "MemoryReviewLease" WHERE "botId" = ${bots[0]!.id}::uuid`;
    expect(lease!.remainingMs).toBeGreaterThan(10_000);
    const startedRecovery = Date.now();
    await Bun.sleep(5_000);
    expect(requests.filter(request => request.runId === interrupted.id)).toHaveLength(1);
    expect(await db.memoryReviewLease.findUniqueOrThrow({ where: { botId: bots[0]!.id } })).toMatchObject({ ownerId: lease!.ownerId, expiresAt: lease!.expiresAt });
    // No manual lease mutation: the surviving process must discover the pending
    // intent again after the real PostgreSQL thirty-second lease expires.
    await until(async () => await db.run.count({ where: { id: interrupted.id, memoryReviewPending: false } }) === 1);
    expect(Date.now() - startedRecovery).toBeGreaterThanOrEqual(lease!.remainingMs - 1_000);
    expect(requests.filter(request => request.runId === interrupted.id).map(request => [request.owner, request.outcome])).toEqual([[owner.token, "aborted"], [survivor.token, "completed"]]);
    expect(new Set(requests.map(request => request.owner)).size).toBe(2);
    expect(maximum.get(0)).toBe(1);

    const facts = await db.memoryFact.findMany({ where: { writtenByBotId: { in: bots.map(bot => bot.id) } } });
    expect(facts).toHaveLength(10);
    expect(new Set(facts.map(fact => `${fact.namespace}:${fact.logicalId}`)).size).toBe(10);
    for (const run of runs) expect(facts.filter(fact => fact.turnId === run.id)).toMatchObject([{ fact: run.fact, origin: "extract", supersededAt: null }]);
    const acknowledgements = await db.$queryRawUnsafe<Array<{ runId: string }>>(`SELECT "runId" FROM "${audit}" ORDER BY sequence`);
    expect(acknowledgements).toHaveLength(10);
    expect(new Set(acknowledgements.map(ack => ack.runId)).size).toBe(10);
    for (let bot = 0; bot < bots.length; bot++) expect(acknowledgements.filter(ack => runs.some(run => run.id === ack.runId && run.bot === bot)).map(ack => runs.find(run => run.id === ack.runId)!.turn)).toEqual(bot === 0 ? [0, 1, 2, 3] : [0, 1, 2]);
    expect(await db.event.count({ where: { topic: "memory.changed", entityId: { in: bots.map(bot => bot.id) } } })).toBe(10);
    expect(await db.run.count({ where: { botId: { in: bots.map(bot => bot.id) }, memoryReviewPending: true } })).toBe(0);
    expect(await db.memoryReviewLease.count({ where: { botId: { in: bots.map(bot => bot.id) } } })).toBe(0);
    for (const bot of await db.bot.findMany({ where: { id: { in: bots.map(bot => bot.id) } } })) expect(bot.pendingMemoryExchanges).toEqual([]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    for (const process of processes) {
      if (process.child.exitCode !== null) continue;
      process.child.kill("SIGTERM"); await Promise.race([process.child.exited, Bun.sleep(5_000)]);
      if (process.child.exitCode === null) process.child.kill("SIGKILL");
      await process.child.exited;
    }
    computer.stop(true);
    if (auditCreated) {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${audit}_trigger" ON "Run"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${audit}_fn"()`);
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${audit}"`);
    }
    await db.memoryFact.deleteMany({ where: { writtenByBotId: { in: bots.map(bot => bot.id) } } });
    await db.event.deleteMany({ where: { entityId: { in: bots.map(bot => bot.id) } } });
    await db.channel.deleteMany({ where: { id: { in: bots.map(bot => bot.channelId) } } });
    await db.bot.deleteMany({ where: { id: { in: bots.map(bot => bot.id) } } });
    await db.$disconnect();
    for (const key of environmentKeys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
