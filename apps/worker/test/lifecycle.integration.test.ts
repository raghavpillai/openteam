import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { AppService } from "../../server/src/app-service";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

test("durable bot mailboxes preserve Pi sessions, agent DMs, and ordered group rounds", async () => {
  if (!databaseUrl) return;

  const workspace = join(tmpdir(), `openbot-integration-${crypto.randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  interface TurnInput {
    runId: string;
    botId: string;
    contextSessionId: string;
    conversationId: string;
    sessionPath: string | null;
    content: string;
    images?: Array<{ url: string }>;
    channelId: string;
    deliveryId: string | null;
    instructions: string;
    userInfo?: string | null;
    userInfoEpoch?: number;
    cwd: string;
  }
  interface SteerInput {
    inboxId: string;
    clientMessageId: string;
    content: string;
    images?: Array<{ url: string }>;
  }
  const seenTurns: TurnInput[] = [];
  const preflightContexts: string[] = [];
  const seenSteers: Array<SteerInput & { runId: string }> = [];
  const deliveredSteers = new Map<string, SteerInput[]>();
  const releaseTurn = new Map<string, () => void>();
  let steerDisposition: "deliver" | "drop" = "deliver";
  let turnNumber = 0;
  let onTurn: (input: TurnInput) => Promise<void> = async () => {};
  const inlineImage = {
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  };
  const turnBody = (content: string) => {
    const body =
      content.match(
        /^<timestamp>[^\n]+<\/timestamp>\n<user_query>\n([\s\S]*?)\n<\/user_query>(?:\n\n[\s\S]*)?$/
      )?.[1] ?? content;
    return body.replace(/^\[t\d+u\]\s?/, "");
  };
  const fakeComputer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({
          status: "ready",
          agent: { ready: true, authenticated: true },
        });
      }
      if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (request.method === "POST" && url.pathname === "/v1/agent-stores/reconcile") {
        return Response.json({ quarantined: [] });
      }
      if (request.method === "PUT" && /^\/v1\/agent-stores\/[^/]+$/.test(url.pathname)) {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/infer") {
        const body = (await request.json()) as { kind?: string };
        const text =
          body.kind === "extraction"
            ? '{"facts":[]}'
            : body.kind === "episode"
              ? '{"narrative":null}'
              : body.kind === "verification"
                ? '{"approved":true}'
                : '{"changes":[]}';
        return Response.json({ text });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/v1/workspaces/")) {
        const body = (await request.json()) as { path: string };
        await mkdir(body.path, { recursive: true });
        return Response.json({ path: body.path });
      }
      if (request.method === "PUT" && url.pathname === "/v1/directories") {
        const body = (await request.json()) as { paths: string[] };
        await Promise.all(body.paths.map((path) => mkdir(path, { recursive: true })));
        return Response.json({ directories: body.paths });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/v1/transcripts/")) {
        return Response.json({ ok: true });
      }
      const steerMatch = url.pathname.match(/^\/v1\/turns\/([^/]+)\/steer$/);
      if (request.method === "POST" && steerMatch?.[1]) {
        const input = (await request.json()) as SteerInput;
        seenSteers.push({ ...input, runId: steerMatch[1] });
        if (steerDisposition === "deliver") {
          const queued = deliveredSteers.get(steerMatch[1]) ?? [];
          queued.push(input);
          deliveredSteers.set(steerMatch[1], queued);
        }
        releaseTurn.get(steerMatch[1])?.();
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && /^\/v1\/turns\/[^/]+\/cancel$/.test(url.pathname)) {
        return Response.json({ ok: true });
      }
      const contextStateMatch = url.pathname.match(/^\/v1\/context-sessions\/([^/]+)$/);
      if (request.method === "GET" && contextStateMatch?.[1]) {
        preflightContexts.push(contextStateMatch[1]);
        return Response.json({
          type: "context.state",
          contextSessionId: contextStateMatch[1],
          epoch: 0,
          archives: [],
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/turns") {
        const input = (await request.json()) as TurnInput;
        seenTurns.push(input);
        await onTurn(input);
        turnNumber += 1;
        const sessionPath =
          input.sessionPath ?? `/var/lib/openbot/pi/${input.contextSessionId}.jsonl`;
        const turnId = `turn-${turnNumber}`;
        const itemId = `agent-${turnNumber}`;
        const text = `durable answer ${turnNumber}`;
        const events = [
          {
            type: "session.attached",
            provider: "pi",
            contextSessionId: input.contextSessionId,
            sessionPath,
            sessionId: input.contextSessionId,
            model: "openai-codex/fake",
          },
          {
            type: "context.state",
            contextSessionId: input.contextSessionId,
            epoch: 0,
            archives: [],
          },
          { type: "turn.started", turnId },
          ...(deliveredSteers.get(input.runId) ?? []).map((steer) => ({
            type: "input.delivered",
            turnId,
            inboxId: steer.inboxId,
            clientMessageId: steer.clientMessageId,
          })),
          {
            type: "runtime.error",
            turnId,
            message: "Transient reconnect",
            retrying: true,
          },
          {
            type: "item.started",
            turnId,
            item: {
              type: "agentMessage",
              id: itemId,
              text: "",
              phase: null,
              memoryCitation: null,
            },
          },
          { type: "agent.delta", turnId, itemId, delta: text },
          {
            type: "item.completed",
            turnId,
            item: {
              type: "agentMessage",
              id: itemId,
              text,
              phase: null,
              memoryCitation: null,
            },
          },
          { type: "turn.completed", turnId, status: "completed" },
        ];
        return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.OPENBOT_COMPUTER_URL = `http://127.0.0.1:${fakeComputer.port}`;
  process.env.OPENBOT_CONTROL_TOKEN = "integration-control-token";
  process.env.OPENBOT_WORKSPACE_ROOT = workspace;
  process.env.OPENBOT_AGENT_DATA_ROOT = join(workspace, "agent-data");

  let app: AppService | null = null;
  let worker: WakeWorker | null = null;
  const close = async () => {
    if (worker) await worker.stop();
    if (app) await Effect.runPromise(app.close());
    worker = null;
    app = null;
  };

  try {
    app = new AppService();
    await app.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Computer", "Bot", "OutboxDelivery", "Event", "IdempotencyRecord" CASCADE'
    );
    await Effect.runPromise(app.boot());
    worker = new WakeWorker();
    await worker.start();

    const bot = await Effect.runPromise(
      app.createBot({
        clientRequestId: "create-durable-0001",
        name: "Durable",
        instructions: "Keep continuity",
        icon: "D",
        color: "#4f7cff",
      })
    );
    const replayedBot = await Effect.runPromise(
      app.createBot({
        clientRequestId: "create-durable-0001",
        name: "Durable",
        instructions: "Keep continuity",
        icon: "D",
        color: "#4f7cff",
      })
    );
    expect(bot.status).toBe("provisioning");
    expect(replayedBot.id).toBe(bot.id);
    expect(await app.prisma.bot.count()).toBe(1);
    const uploadedImage = await Effect.runPromise(
      app.uploadAsset({
        fileName: "image.png",
        mimeType: "image/png",
        bytesBase64: inlineImage.url.slice(inlineImage.url.indexOf(",") + 1),
      })
    );
    const conversationId = bot.conversationId;
    const first = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "first",
        clientId: "client-first-0001",
        attachments: [uploadedImage],
        timeZone: "Asia/Jerusalem",
      })
    )) as { run: { id: string } };
    const duplicate = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "first",
        clientId: "client-first-0001",
        attachments: [uploadedImage],
        timeZone: "Asia/Jerusalem",
      })
    )) as { run: { id: string } };
    expect(duplicate.run.id).toBe(first.run.id);

    const waitFor = async (runId: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const snapshot = await Effect.runPromise(app!.snapshot());
        const run = snapshot.runs.find((candidate) => candidate.id === runId);
        if (run?.status === "completed") return snapshot;
        await Bun.sleep(50);
      }
      throw new Error(`run ${runId} did not complete`);
    };
    const waitUntil = async (predicate: () => Promise<boolean>, label: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(50);
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const firstSnapshot = await waitFor(first.run.id);
    expect(firstSnapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(
      1
    );
    expect(seenTurns.map((turn) => turn.sessionPath)).toEqual([null]);
    const firstSeenTurn = seenTurns[0];
    if (!firstSeenTurn) throw new Error("Expected the first computer turn");
    expect(preflightContexts).toEqual([firstSeenTurn.contextSessionId]);
    expect(seenTurns[0]?.cwd).toBe(bot.defaultDirectory);
    expect(seenTurns[0]?.images).toEqual([inlineImage]);
    expect(seenTurns[0]?.content).toMatch(
      /^<timestamp>.+ \(UTC\+3\)<\/timestamp>\n<user_query>\n\[t\d+u\] first\n<\/user_query>/
    );
    expect(seenTurns[0]?.content).toContain("Attached files available on the shared computer:");
    expect(seenTurns[0]?.content).toContain(
      join(workspace, "agent-data", "agents", bot.id, "attachments", `${uploadedImage.assetId}.png`)
    );
    expect(
      firstSnapshot.channelMessages.find(
        (message) => message.channelId === bot.dmChannelId && message.sender === "user"
      )?.content
    ).toBe("first");
    expect(
      firstSnapshot.channelMessages.find(
        (message) => message.channelId === bot.dmChannelId && message.sender === "user"
      )?.metadata
    ).toMatchObject({ attachments: [uploadedImage] });
    const firstClientSnapshot = await Effect.runPromise(app.clientSnapshot());
    expect("messages" in firstClientSnapshot).toBe(false);
    expect(
      firstClientSnapshot.channelMessages.find(
        (message) => message.channelId === bot.dmChannelId && message.sender === "user"
      )?.content
    ).toBe("first");
    expect(firstSnapshot.bots.find((candidate) => candidate.id === bot.id)?.onboardingStatus).toBe(
      "skipped_by_user"
    );
    expect(firstSnapshot.workspace).toMatchObject({
      root: workspace,
      botsDirectory: join(workspace, "bots"),
      projectsDirectory: join(workspace, "projects"),
      sharedDirectory: join(workspace, "shared"),
    });

    await close();
    app = new AppService();
    await Effect.runPromise(app.boot());
    worker = new WakeWorker();
    await worker.start();
    const second = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "second",
        clientId: "client-second-0002",
      })
    )) as { run: { id: string } };
    const secondSnapshot = await waitFor(second.run.id);
    expect(seenTurns.map((turn) => turn.sessionPath)).toEqual([
      null,
      `/var/lib/openbot/pi/${firstSeenTurn.contextSessionId}.jsonl`,
    ]);
    expect(preflightContexts).toEqual(seenTurns.map((turn) => turn.contextSessionId));
    expect(seenTurns[1]?.cwd).toBe(bot.defaultDirectory);
    expect(secondSnapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(
      2
    );
    expect(
      secondSnapshot.runItems.filter(
        (item) => item.runId === second.run.id && item.kind === "error"
      )
    ).toMatchObject([{ status: "completed" }]);

    onTurn = async (input) => {
      if (turnBody(input.content) !== "steering base task") return;
      await new Promise<void>((resolve) => releaseTurn.set(input.runId, resolve));
      releaseTurn.delete(input.runId);
    };
    const steeringBase = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "steering base task",
        clientId: "client-steering-base-0003",
      })
    )) as { run: { id: string } };
    await waitUntil(
      async () => releaseTurn.has(steeringBase.run.id),
      "active user turn ready for steering"
    );
    const redirected = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "redirect the active task",
        clientId: "client-steering-inline-0004",
        attachments: [uploadedImage],
      })
    )) as { run: { id: string } };
    expect(redirected.run.id).toBe(steeringBase.run.id);
    await waitFor(steeringBase.run.id);
    expect(
      seenTurns.filter(
        (turn) =>
          turnBody(turn.content) === "steering base task" ||
          turnBody(turn.content) === "redirect the active task"
      )
    ).toHaveLength(1);
    expect(seenSteers.at(-1)).toMatchObject({
      runId: steeringBase.run.id,
      clientMessageId: "client-steering-inline-0004",
    });
    expect(turnBody(seenSteers.at(-1)?.content ?? "")).toBe("redirect the active task");
    expect(seenSteers.at(-1)?.images).toEqual([inlineImage]);
    const deliveredSteer = await app.prisma.inboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: "client-steering-inline-0004" },
    });
    const deliveredMessage = await app.prisma.message.findUniqueOrThrow({
      where: {
        conversationId_clientId: {
          conversationId,
          clientId: "client-steering-inline-0004",
        },
      },
    });
    expect(deliveredSteer).toMatchObject({
      runId: steeringBase.run.id,
      deliveryMode: "steer",
      status: "completed",
    });
    expect(deliveredMessage.runId).toBe(steeringBase.run.id);

    steerDisposition = "drop";
    onTurn = async (input) => {
      if (turnBody(input.content) !== "fallback base task") return;
      await new Promise<void>((resolve) => releaseTurn.set(input.runId, resolve));
      releaseTurn.delete(input.runId);
    };
    const fallbackBase = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "fallback base task",
        clientId: "client-fallback-base-0005",
      })
    )) as { run: { id: string } };
    await waitUntil(
      async () => releaseTurn.has(fallbackBase.run.id),
      "active user turn ready for fallback"
    );
    const fallbackAccepted = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "recover this undelivered instruction",
        clientId: "client-fallback-steer-0006",
      })
    )) as { run: { id: string } };
    expect(fallbackAccepted.run.id).toBe(fallbackBase.run.id);
    await waitUntil(
      async () =>
        seenTurns.some((turn) => turnBody(turn.content) === "recover this undelivered instruction"),
      "undelivered steer fallback turn"
    );
    const recoveredSteer = await app.prisma.inboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: "client-fallback-steer-0006" },
    });
    const recoveredMessage = await app.prisma.message.findUniqueOrThrow({
      where: {
        conversationId_clientId: {
          conversationId,
          clientId: "client-fallback-steer-0006",
        },
      },
    });
    expect(recoveredSteer.deliveryMode).toBe("turn");
    expect(recoveredSteer.runId).not.toBe(fallbackBase.run.id);
    expect(recoveredMessage.runId).toBe(recoveredSteer.runId);
    await waitFor(recoveredSteer.runId);
    steerDisposition = "deliver";
    onTurn = async () => {};

    let peerId = "";
    onTurn = async (input) => {
      if (input.content.includes("[OpenBot first start]")) {
        await Effect.runPromise(
          app!.handleDynamicTool({
            runId: input.runId,
            botId: input.botId,
            conversationId: input.conversationId,
            channelId: input.channelId,
            deliveryId: input.deliveryId,
            tool: "SendToUser",
            arguments: { type: "text", content: `Hello from ${input.botId}.` },
            callId: `bootstrap-visible-${input.botId}`,
          })
        );
      } else if (input.botId === bot.id && input.content.includes("private alpha instruction")) {
        const request = {
          runId: input.runId,
          botId: input.botId,
          conversationId: input.conversationId,
          channelId: input.channelId,
          deliveryId: input.deliveryId,
          tool: "SendToAgent",
          arguments: {
            target_id: peerId,
            message: "Please verify this handoff.",
            priority: false,
          },
          callId: "direct-send-once",
        } as const;
        await Effect.runPromise(app!.handleDynamicTool(request));
        const duplicate = await Effect.runPromise(app!.handleDynamicTool(request));
        expect(duplicate).toBe(
          "Sent to Peer. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now."
        );
        await Effect.runPromise(
          app!.handleDynamicTool({
            ...request,
            tool: "SendToUser",
            arguments: { type: "text", content: "Peer was notified." },
            callId: "direct-visible-source",
          })
        );
      } else if (input.botId === peerId && input.content.includes("[agent]")) {
        await Effect.runPromise(
          app!.handleDynamicTool({
            runId: input.runId,
            botId: input.botId,
            conversationId: input.conversationId,
            channelId: input.channelId,
            deliveryId: input.deliveryId,
            tool: "SendToAgent",
            arguments: {
              target_id: bot.id,
              message: "Verified. The handoff works.",
            },
            callId: "direct-visible-reply",
          })
        );
      }
    };

    const peer = await Effect.runPromise(
      app.createBot({
        clientRequestId: "create-peer-0002",
        name: "Peer",
        instructions: "Reply to useful direct messages.",
        icon: "P",
        color: "#7c3aed",
      })
    );
    peerId = peer.id;
    const reviewer = await Effect.runPromise(
      app.createBot({
        clientRequestId: "create-reviewer-0003",
        name: "Reviewer",
        instructions: "Add a concise independent view in groups.",
        icon: "R",
        color: "#059669",
      })
    );
    await waitUntil(async () => {
      const bots = await app!.prisma.bot.findMany({
        where: { id: { in: [peer.id, reviewer.id] } },
        select: { onboardingStatus: true },
      });
      return (
        bots.length === 2 && bots.every((candidate) => candidate.onboardingStatus === "completed")
      );
    }, "proactive onboarding");
    expect(
      await app.prisma.inboxEvent.count({
        where: { botId: { in: [peer.id, reviewer.id] }, type: "bot.bootstrap" },
      })
    ).toBe(2);
    const onboardingSnapshot = await Effect.runPromise(app.snapshot());
    for (const created of [peer, reviewer]) {
      expect(
        onboardingSnapshot.channelMessages.filter(
          (message) =>
            message.channelId === created.dmChannelId &&
            message.sender === "agent" &&
            message.content === `Hello from ${created.id}.`
        )
      ).toHaveLength(1);
    }

    const directSource = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "private alpha instruction: delegate without sharing this sentence",
        clientId: "client-direct-0003",
      })
    )) as { run: { id: string } };
    await waitFor(directSource.run.id);

    await waitUntil(async () => {
      const count = await app!.prisma.inboxEvent.count({
        where: { status: { in: ["pending", "processing"] } },
      });
      return count === 0;
    }, "agent DM wakes");

    const directSnapshot = await Effect.runPromise(app.snapshot());
    expect(directSnapshot.channels.some((channel) => channel.kind === "agent_dm")).toBe(false);
    const directClientSnapshot = await Effect.runPromise(app.clientSnapshot());
    expect(directClientSnapshot.channels.some((channel) => channel.kind === "agent_dm")).toBe(
      false
    );
    expect(
      directSnapshot.channelMessages
        .filter((message) => message.channelId === bot.dmChannelId && message.sender === "agent")
        .some((message) => message.content === "Peer was notified.")
    ).toBe(true);
    const sourceA2A = directSnapshot.channelMessages.filter(
      (message) =>
        message.channelId === bot.dmChannelId &&
        message.metadata &&
        typeof message.metadata === "object" &&
        ("toAgent" in message.metadata || "fromAgent" in message.metadata)
    );
    expect(sourceA2A.map((message) => message.content)).toEqual([
      "Please verify this handoff.",
      "Verified. The handoff works.",
    ]);
    expect(sourceA2A[0]?.metadata).toEqual({
      toAgent: { id: peer.id, name: "Peer", kind: "agent" },
    });
    expect(sourceA2A[1]?.metadata).toEqual({
      fromAgent: { id: peer.id, name: "Peer" },
    });
    const peerA2A = directSnapshot.channelMessages.filter(
      (message) =>
        message.channelId === peer.dmChannelId &&
        message.metadata &&
        typeof message.metadata === "object" &&
        ("toAgent" in message.metadata || "fromAgent" in message.metadata)
    );
    expect(peerA2A).toHaveLength(2);
    expect(peerA2A.map((message) => message.sender)).toEqual(["user", "agent"]);
    expect(peerA2A[0]?.metadata).toEqual({
      fromAgent: { id: bot.id, name: bot.name },
    });
    expect(
      directSnapshot.messages
        .filter((message) => message.conversationId === peer.conversationId)
        .some((message) => message.content.includes("private alpha instruction"))
    ).toBe(false);

    await worker.stop();
    worker = null;
    const queuedForCancellation = (await Effect.runPromise(
      app.sendMessage(conversationId, {
        content: "cancel this before it starts",
        clientId: "client-cancel-queued-0007",
      })
    )) as { run: { id: string } };
    expect(await Effect.runPromise(app.cancelRun(queuedForCancellation.run.id))).toMatchObject({
      status: "cancelled",
    });
    expect(
      await app.prisma.inboxEvent.findUniqueOrThrow({
        where: { idempotencyKey: "client-cancel-queued-0007" },
      })
    ).toMatchObject({ status: "completed", deliveryMode: "turn" });

    const group = await Effect.runPromise(
      app.createGroup({
        name: "Ordered room",
        botIds: [bot.id, peer.id, reviewer.id],
      })
    );
    expect(group.workingDirectory).toBe(workspace);
    await Effect.runPromise(
      app.updateChannelProfile(group.id, {
        name: group.name,
        description: "Coordinate ordered parity checks.",
        clientId: "group-profile-ordered-checks",
      })
    );
    const accepted = (await Effect.runPromise(
      app.sendChannelMessage(group.id, {
        content: "Give one compact status line.",
        clientId: "client-group-0004",
        attachments: [uploadedImage],
        timeZone: "Asia/Jerusalem",
      })
    )) as { round: { id: string } };

    onTurn = async (input) => {
      if (input.channelId !== group.id) return;
      if (input.botId === bot.id) {
        await Effect.runPromise(
          app!.handleDynamicTool({
            runId: input.runId,
            botId: input.botId,
            conversationId: input.conversationId,
            channelId: input.channelId,
            deliveryId: input.deliveryId,
            tool: "SendToUser",
            arguments: {
              type: "text",
              content: "Private group-turn note.",
              to: "dm",
            },
            callId: "group-private-dm",
          })
        );
        let sameGroupError: unknown;
        try {
          await Effect.runPromise(
            app!.handleDynamicTool({
              runId: input.runId,
              botId: input.botId,
              conversationId: input.conversationId,
              channelId: input.channelId,
              deliveryId: input.deliveryId,
              tool: "SendToAgent",
              arguments: { target_id: group.id, message: "Wrong group reply primitive." },
              callId: "group-wrong-send-to-agent",
            })
          );
        } catch (error) {
          sameGroupError = error;
        }
        expect(String(sameGroupError)).toContain("Use SendToUser");
      }
      await Effect.runPromise(
        app!.handleDynamicTool({
          runId: input.runId,
          botId: input.botId,
          conversationId: input.conversationId,
          channelId: input.channelId,
          deliveryId: input.deliveryId,
          tool: "SendToUser",
          arguments: {
            type: "text",
            content: `Group answer from ${input.botId}`,
          },
          callId: `group-visible-${input.botId}`,
        })
      );
      if (input.botId === bot.id) {
        await app!.prisma.channelMessage.create({
          data: {
            channelId: group.id,
            sender: "user",
            clientId: "post-trigger-user-message",
            content: "This arrived after the round trigger and belongs to the next round.",
          },
        });
      }
    };
    worker = new WakeWorker();
    await worker.start();
    await waitUntil(async () => {
      const round = await app!.prisma.channelRound.findUnique({
        where: { id: accepted.round.id },
      });
      return round?.status === "completed";
    }, "ordered group round");

    const groupSnapshot = await Effect.runPromise(app.snapshot());
    const groupTurns = seenTurns.filter((turn) => turn.channelId === group.id);
    expect(groupTurns.map((turn) => turn.botId)).toEqual([bot.id, peer.id, reviewer.id]);
    expect(
      groupTurns.every((turn) => turn.content.includes("Room: Coordinate ordered parity checks."))
    ).toBe(true);
    expect(groupTurns.every((turn) => turn.cwd === group.workingDirectory)).toBe(true);
    expect(
      groupTurns.every((turn) => JSON.stringify(turn.images) === JSON.stringify([inlineImage]))
    ).toBe(true);
    expect(
      groupTurns.every(
        (turn) =>
          turn.content.startsWith('[Group chat: "Ordered room"') &&
          !turn.content.includes("<timestamp>")
      )
    ).toBe(true);
    expect(turnBody(groupTurns[1]?.content ?? "")).toContain(`Group answer from ${bot.id}`);
    expect(turnBody(groupTurns[2]?.content ?? "")).toContain(`Group answer from ${bot.id}`);
    expect(turnBody(groupTurns[2]?.content ?? "")).toContain(`Group answer from ${peer.id}`);
    expect(
      groupTurns.slice(1).every((turn) => !turn.content.includes("belongs to the next round"))
    ).toBe(true);
    expect(
      groupSnapshot.channelMessages
        .filter((message) => message.channelId === group.id)
        .map((message) => message.content)
    ).toEqual([
      "Give one compact status line.",
      `Group answer from ${bot.id}`,
      "This arrived after the round trigger and belongs to the next round.",
      `Group answer from ${peer.id}`,
      `Group answer from ${reviewer.id}`,
    ]);
    expect(
      groupSnapshot.channelMessages.some(
        (message) =>
          message.channelId === bot.dmChannelId && message.content === "Private group-turn note."
      )
    ).toBe(true);
    expect(
      groupSnapshot.channelRounds.find((round) => round.id === accepted.round.id)?.status
    ).toBe("completed");
    expect(groupTurns.every((turn) => turn.instructions.includes(group.id))).toBe(true);
    expect(
      groupTurns.every(
        (turn) =>
          turn.userInfo?.startsWith("<user_info>\n<agent_skills>") &&
          turn.userInfo.endsWith("</agent_skills>\n</user_info>") &&
          turn.userInfoEpoch === 0
      )
    ).toBe(true);
    expect(
      groupTurns.every(
        (turn) => turn.sessionPath === `/var/lib/openbot/pi/${turn.contextSessionId}.jsonl`
      )
    ).toBe(true);
    expect(new Set(groupTurns.map((turn) => turn.contextSessionId)).size).toBe(3);
    expect(
      groupTurns.every(
        (turn) =>
          turn.contextSessionId ===
          seenTurns.find(
            (candidate) => candidate.botId === turn.botId && candidate.channelId !== group.id
          )?.contextSessionId
      )
    ).toBe(true);
  } finally {
    await close();
    fakeComputer.stop(true);
  }
}, 90_000);
