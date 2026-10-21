import { describe, expect, test } from "bun:test";
import { defaultTaskConfiguration } from "@openteam/contracts/task-configuration";
import { BOOTSTRAP_ATTEMPT_LIMIT, BOOTSTRAP_RETRY_PROBE_MS, WakeWorker } from "../src/worker";

const claimed = {
  inboxId: "inbox",
  inboxType: "bot.bootstrap",
  runId: "run",
  botId: "bot",
  contextSessionId: "context",
  screenBotId: "bot",
  pluginBotId: "bot",
  conversationId: "conversation",
  ownerId: "owner",
  content: "[OpenTeam first start]",
  images: [],
  clientId: "bot:bot:bootstrap:v1",
  cwd: "/workspace",
  instructions: "",
  sessionPath: null,
  channelId: "channel",
  deliveryId: null,
  origin: "bootstrap",
  runtimeProfile: "agent",
  subagentType: null,
  readOnly: false,
  inferenceParentRunId: null,
  combinedComputerUse: null,
  taskConfiguration: null,
  fileAttachments: [],
  attachmentOwnerBotId: "bot",
};

const NORMAL_FAILURE_PATH = new Error("normal failure path");

/** A worker whose transactions outside the requeue stand for the existing failure path. */
const workerWith = (state: {
  onboardingStatus?: string;
  runStatus?: string;
  attempts?: number;
  greeted?: boolean;
}) => {
  const writes: Array<{ model: string; args: any }> = [];
  const wakes: string[] = [];
  let requeuing = false;
  const record = (model: string) => async (args: any) => {
    writes.push({ model, args });
    return {};
  };
  const tx = {
    $queryRaw: async () => [],
    bot: {
      findUnique: async () => ({
        status: "active",
        onboardingStatus: state.onboardingStatus ?? "running",
      }),
      update: record("bot.update"),
    },
    run: {
      findUnique: async () => ({ status: state.runStatus ?? "running" }),
      update: record("run.update"),
    },
    inboxEvent: {
      findUnique: async () => ({ attempts: state.attempts ?? 1 }),
      update: record("inboxEvent.update"),
    },
    channelMessage: { findFirst: async () => (state.greeted ? { id: "hello" } : null) },
    runItem: { findMany: async () => [] },
    botRunLease: { deleteMany: record("botRunLease.deleteMany") },
    event: { create: record("event.create") },
  };
  const worker = Object.create(WakeWorker.prototype) as any;
  worker.prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
      if (!requeuing) throw NORMAL_FAILURE_PATH;
      return work(tx);
    },
  };
  const requeue = worker.requeueInterruptedBootstrap;
  worker.requeueInterruptedBootstrap = async (...args: unknown[]) => {
    requeuing = true;
    try {
      return await requeue.apply(worker, args);
    } finally {
      requeuing = false;
    }
  };
  worker.messaging = {
    promoteUndeliveredSteers: async () => 0,
    scheduleTranscriptProjection: async () => {},
  };
  worker.wakeBootstrapWhenComputerReady = async (botId: string) => {
    wakes.push(botId);
  };
  return { worker, writes, wakes };
};

describe("first greeting cut off by the computer", () => {
  test("goes back in line for the computer's return instead of failing", async () => {
    const { worker, writes, wakes } = workerWith({});
    const before = Date.now();
    await worker.fail(claimed, new TypeError("fetch failed"), true);

    const write = (model: string) => writes.find((entry) => entry.model === model)?.args;
    expect(write("botRunLease.deleteMany").where).toEqual({ botId: "bot", ownerId: "owner" });
    const inbox = write("inboxEvent.update");
    expect(inbox.where).toEqual({ id: "inbox" });
    expect(inbox.data.status).toBe("pending");
    expect(inbox.data.claimedAt).toBeNull();
    // Not claimable by this worker's wake loop until the first readiness probe.
    expect(inbox.data.availableAt.getTime()).toBeGreaterThanOrEqual(
      before + BOOTSTRAP_RETRY_PROBE_MS
    );
    expect(write("run.update").data).toEqual({ status: "queued" });
    expect(write("bot.update").data).toEqual({ onboardingStatus: "queued" });
    expect(write("event.create").data).toMatchObject({
      topic: "bot.bootstrap.retry_queued",
      payload: { botId: "bot", runId: "run", attempts: 1, message: "fetch failed" },
    });
    expect(writes.some((entry) => entry.args.data?.onboardingStatus === "failed")).toBe(false);
    expect(wakes).toEqual(["bot"]);
  });

  test.each([
    ["the computer reported the turn failed", {}, false],
    ["a greeting was already delivered", { greeted: true }, true],
    ["the user spoke first", { onboardingStatus: "skipped_by_user", runStatus: "cancelled" }, true],
    ["its attempts are used up", { attempts: BOOTSTRAP_ATTEMPT_LIMIT }, true],
  ] as const)("fails as before when %s", async (_case, state, interrupted) => {
    const { worker, writes, wakes } = workerWith(state);
    await expect(worker.fail(claimed, new Error("turn ended"), interrupted)).rejects.toBe(
      NORMAL_FAILURE_PATH
    );
    expect(writes).toEqual([]);
    expect(wakes).toEqual([]);
  });

  test("other runs the computer cut off fail as before", async () => {
    const { worker, writes } = workerWith({});
    await expect(
      worker.fail({ ...claimed, origin: "user" }, new TypeError("fetch failed"), true)
    ).rejects.toBe(NORMAL_FAILURE_PATH);
    expect(writes).toEqual([]);
  });

  test("the retry waits until the computer reports ready", async () => {
    let ready = false;
    let probes = 0;
    const computer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/health") return new Response(null, { status: 404 });
        probes += 1;
        return Response.json(
          { status: ready ? "ready" : "degraded" },
          { status: ready ? 200 : 503 }
        );
      },
    });
    try {
      const sent: Array<{ name: string; data: unknown }> = [];
      const worker = Object.create(WakeWorker.prototype) as any;
      worker.stopping = false;
      worker.computerUrl = computer.url.origin;
      worker.boss = { send: async (name: string, data: unknown) => sent.push({ name, data }) };
      const waiting = worker.wakeBootstrapWhenComputerReady("bot", 25);
      while (probes < 3) await Bun.sleep(5);
      expect(sent).toEqual([]);
      ready = true;
      await waiting;
      expect(sent).toEqual([{ name: "bot-wake", data: { botId: "bot" } }]);
    } finally {
      computer.stop(true);
    }
  });
});

describe("execute tells a computer outage from a reported failure", () => {
  const run = async (turn: "unreachable" | "cut" | "failed") => {
    const computer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/context-sessions/context") {
          return Response.json({
            type: "context.state",
            contextSessionId: "context",
            epoch: 0,
            archives: [],
          });
        }
        if (path === "/v1/task-capabilities") {
          return Response.json({ desktopAvailable: true, boxAvailable: true });
        }
        // A computer that dies mid-turn ends the stream with no completion.
        if (turn === "cut") return new Response('{"type":"turn.started","turnId":"turn"}\n');
        return new Response(
          `${JSON.stringify({
            type: "turn.completed",
            turnId: "turn",
            status: "failed",
            error: { message: "The model refused" },
          })}\n`
        );
      },
    });
    const failures: Array<{ error: unknown; interrupted: boolean }> = [];
    const worker = Object.create(WakeWorker.prototype) as any;
    worker.computerUrl = turn === "unreachable" ? "http://127.0.0.1:9" : computer.url.origin;
    worker.controlToken = "token";
    worker.prisma = {
      pluginInstallation: { findMany: async () => [] },
      run: { update: async () => ({}), findUnique: async () => ({ status: "running" }) },
    };
    worker.agentData = {
      loadInferenceSettings: async () => ({
        providerId: "openai",
        modelId: "gpt-5",
        reasoning: "medium",
      }),
      loadTaskConfiguration: async () => defaultTaskConfiguration(),
    };
    worker.messaging = { platformPrompt: async () => ({ instructions: "" }) };
    worker.projection = { apply: async () => {} };
    worker.pushNotifications = { drain: async () => {} };
    worker.fail = async (_claimed: unknown, error: unknown, interrupted: boolean) => {
      failures.push({ error, interrupted });
    };
    try {
      // A graphical worker profile loads no plugin skills, so execute needs no plugin fixtures.
      await worker.execute({ ...claimed, runtimeProfile: "subagent", subagentType: "computerUse" });
    } finally {
      computer.stop(true);
    }
    expect(failures).toHaveLength(1);
    return failures[0]!;
  };

  test("an unreachable computer is an interruption", async () => {
    expect((await run("unreachable")).interrupted).toBe(true);
  });

  test("a stream that ends without a completion is an interruption", async () => {
    const failure = await run("cut");
    expect(failure.interrupted).toBe(true);
    expect(String(failure.error)).toContain("without an authoritative turn completion");
  });

  test("a turn the computer reports as failed is final", async () => {
    const failure = await run("failed");
    expect(failure.interrupted).toBe(false);
    expect(String(failure.error)).toContain("The model refused");
  });
});
