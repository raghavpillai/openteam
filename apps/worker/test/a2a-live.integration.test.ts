import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { AppService } from "../../server/src/app-service";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

test("live 1:1 A2A mirrors both home stores and wakes both agents without a pair store", async () => {
  if (!databaseUrl) return;

  const workspace = join(tmpdir(), `openbot-a2a-live-${crypto.randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  const parityImagePath = join(workspace, "parity-pixel.png");
  await writeFile(
    parityImagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const parityImageUrl = `file://${parityImagePath}`;
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
  }
  const turns: TurnInput[] = [];
  const acknowledgements: string[] = [];
  let app: AppService | null = null;
  let worker: WakeWorker | null = null;
  let sourceId = "";
  let probeId = "";
  let ackWakeSeen = false;
  let turnNumber = 0;

  const requireApp = () => {
    if (!app) throw new Error("A2A test app is not ready");
    return app;
  };
  const waitUntil = async (predicate: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const fakeComputer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ready", agent: { ready: true, authenticated: true } });
      }
      if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
      if (request.method === "PUT" && /^\/v1\/agent-stores\/[^/]+$/.test(url.pathname)) {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/agent-stores/reconcile") {
        return Response.json({ quarantined: [] });
      }
      if (request.method === "POST" && url.pathname === "/v1/infer") {
        return Response.json({ text: '{"facts":[]}' });
      }
      if (request.method === "POST" && /^\/v1\/turns\/[^/]+\/cancel$/.test(url.pathname)) {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/turns") {
        const input = (await request.json()) as TurnInput;
        turns.push(input);
        if (input.botId === sourceId && input.content.includes("Start live A2A parity run")) {
          acknowledgements.push(
            String(
              await Effect.runPromise(
                requireApp().handleDynamicTool({
                  runId: input.runId,
                  botId: input.botId,
                  conversationId: input.conversationId,
                  channelId: input.channelId,
                  deliveryId: input.deliveryId,
                  tool: "SendToAgent",
                  arguments: {
                    target_id: probeId,
                    message: "Live A2A capture from Source. Reply with exactly: ACK",
                    images: [{ url: parityImageUrl, alt: "Parity pixel" }],
                  },
                  callId: "a2a-live-ping",
                })
              )
            )
          );
        } else if (input.botId === probeId && input.content.includes("[agent]")) {
          acknowledgements.push(
            String(
              await Effect.runPromise(
                requireApp().handleDynamicTool({
                  runId: input.runId,
                  botId: input.botId,
                  conversationId: input.conversationId,
                  channelId: input.channelId,
                  deliveryId: input.deliveryId,
                  tool: "SendToAgent",
                  arguments: { target_id: sourceId, message: "ACK" },
                  callId: "a2a-live-ack",
                })
              )
            )
          );
        } else if (
          input.botId === sourceId &&
          input.content.includes("[agent]") &&
          input.content.includes("Parity Probe: ACK")
        ) {
          ackWakeSeen = true;
        }

        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        const itemId = `agent-${turnNumber}`;
        const sessionPath =
          input.sessionPath ?? `/var/lib/openbot/pi/${input.contextSessionId}.jsonl`;
        const text = `turn ${turnNumber} complete`;
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
  process.env.OPENBOT_CONTROL_TOKEN = "a2a-live-control-token";
  process.env.OPENBOT_WORKSPACE_ROOT = workspace;
  process.env.OPENBOT_AGENT_DATA_ROOT = join(workspace, "agent-data");

  try {
    app = new AppService();
    await app.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Computer", "Bot", "OutboxDelivery", "Event", "IdempotencyRecord" CASCADE'
    );
    await Effect.runPromise(app.boot());
    const runningWorker = new WakeWorker();
    worker = runningWorker;
    await runningWorker.start();

    const source = await Effect.runPromise(
      app.createBot({ clientRequestId: "a2a-source", name: "Source" })
    );
    const probe = await Effect.runPromise(
      app.createBot({ clientRequestId: "a2a-probe", name: "Parity Probe" })
    );
    sourceId = source.id;
    probeId = probe.id;
    await waitUntil(async () => {
      const bots = await requireApp().prisma.bot.findMany({
        where: { id: { in: [sourceId, probeId] } },
        select: { onboardingStatus: true },
      });
      return bots.length === 2 && bots.every((bot) => bot.onboardingStatus === "completed");
    }, "both agent bootstraps");
    await runningWorker.routines.mutate(probeId, "a2a-routine-handwritten", null, {
      action: "create",
      name: "parity-probe-handwritten",
      prompt: "Harmless parity fixture",
      schedule: "0 0 * * *",
      enabled: false,
      source: "ui",
    });
    const harmless = await runningWorker.routines.mutate(probeId, "a2a-routine-harmless", null, {
      action: "create",
      name: "parity-probe-harmless",
      prompt: "Harmless parity fixture",
      schedule: "0 0 * * *",
      enabled: false,
      source: "ui",
    });
    await runningWorker.agentData.stopWatching();
    await app.prisma.$transaction(async (tx) => {
      await tx.routine.update({
        where: { id: String(harmless.id) },
        data: {
          lastRunAt: new Date("2026-08-27T19:51:57.000Z"),
          runLedger: [
            {
              id: "grok-parity-manual-run",
              trigger: "manual",
              startedAt: Date.parse("2026-08-27T19:51:55.000Z"),
              finishedAt: Date.parse("2026-08-27T19:51:57.000Z"),
              status: "ok",
            },
          ],
        },
      });
      await runningWorker.agentData.writeRoutine(probeId, String(harmless.id), tx);
    });
    await runningWorker.agentData.startWatching();
    expect(await app.prisma.routine.count({ where: { botId: probeId, deletedAt: null } })).toBe(2);

    await Effect.runPromise(
      app.sendMessage(source.conversationId, {
        content: "Start live A2A parity run",
        clientId: "a2a-live-user-turn",
        timeZone: "Asia/Jerusalem",
      })
    );
    await waitUntil(async () => {
      const pending = await requireApp().prisma.inboxEvent.count({
        where: { status: { in: ["pending", "processing"] } },
      });
      return pending === 0 && ackWakeSeen;
    }, "A2A ACK wake");

    const snapshot = await Effect.runPromise(app.snapshot());
    expect(snapshot.channels.some((channel) => channel.kind === "agent_dm")).toBe(false);

    const sourceProjection = snapshot.channelMessages.filter(
      (message) =>
        message.channelId === source.dmChannelId &&
        message.metadata &&
        typeof message.metadata === "object" &&
        ("toAgent" in message.metadata || "fromAgent" in message.metadata)
    );
    expect(sourceProjection.map((message) => message.sender)).toEqual(["agent", "user"]);
    expect(sourceProjection.map((message) => message.content)).toEqual([
      "Live A2A capture from Source. Reply with exactly: ACK",
      "ACK",
    ]);
    expect(sourceProjection[0]?.metadata).toMatchObject({
      toAgent: { id: probeId, name: "Parity Probe", kind: "agent" },
    });
    expect(sourceProjection[1]?.metadata).toEqual({
      fromAgent: { id: probeId, name: "Parity Probe" },
    });

    const probeProjection = snapshot.channelMessages.filter(
      (message) =>
        message.channelId === probe.dmChannelId &&
        message.metadata &&
        typeof message.metadata === "object" &&
        ("toAgent" in message.metadata || "fromAgent" in message.metadata)
    );
    expect(probeProjection.map((message) => message.sender)).toEqual(["user", "agent"]);
    expect(probeProjection[0]?.metadata).toMatchObject({
      fromAgent: { id: sourceId, name: "Source" },
    });
    expect(probeProjection[1]?.metadata).toEqual({
      toAgent: { id: sourceId, name: "Source", kind: "agent" },
    });

    expect(acknowledgements).toEqual([
      "Sent to Parity Probe. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.",
      "Sent to Source. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.",
    ]);
    const peerTurns = turns.filter((turn) => turn.content.includes("[agent]"));
    expect(peerTurns.map((turn) => turn.botId)).toEqual([probeId, sourceId]);
    const probeTurn = peerTurns.find((turn) => turn.botId === probeId);
    const sourceTurn = peerTurns.find((turn) => turn.botId === sourceId);
    expect(probeTurn?.content).toContain(`[SAND_HIDDEN_PROMPT]<system_reminder>
<automation_status>
Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.
- parity-probe-handwritten (folder parity-probe-handwritten): never run
- parity-probe-harmless (folder parity-probe-harmless): last run 8/27/2026, 10:51:57 PM (succeeded)
</automation_status>
</system_reminder>

[agent] A message just arrived from another of your user's agents: Source (id: ${sourceId}).`);
    expect(probeTurn?.content).toStartWith("<timestamp>");
    expect(probeTurn?.content).toContain("</timestamp>\n<user_query>\n[SAND_HIDDEN_PROMPT]");
    expect(probeTurn?.content).toContain(`${parityImageUrl} — Parity pixel`);
    expect(probeTurn?.content).toContain(
      "Local image files are shown to you alongside this message."
    );
    expect(probeTurn?.content).not.toContain("Attached files available on the shared computer:");
    expect(probeTurn?.images).toHaveLength(1);
    expect(sourceTurn?.content).toContain(
      `[SAND_HIDDEN_PROMPT][agent] A message just arrived from another of your user's agents: Parity Probe (id: ${probeId}).`
    );
    expect(peerTurns.every((turn) => turn.content.includes("<peer_message_json>"))).toBe(false);
    expect(peerTurns.every((turn) => turn.content.includes("use SendToUser"))).toBe(true);
    expect(peerTurns.every((turn) => !turn.content.includes("\n[SAND_HIDDEN_PROMPT]\n"))).toBe(
      true
    );
    expect(
      peerTurns.every(
        (turn) =>
          turn.instructions.includes("Agent-to-agent messaging is asynchronous, like texting.") &&
          turn.instructions.includes("Reply to a peer with SendToAgent") &&
          turn.instructions.includes("Available SendToAgent targets:")
      )
    ).toBe(true);
    expect(snapshot.runs.filter((run) => run.origin === "agent").map((run) => run.botId)).toEqual([
      probeId,
      sourceId,
    ]);

    const clientSnapshot = await Effect.runPromise(app.clientSnapshot());
    expect(clientSnapshot.channels.some((channel) => channel.kind === "agent_dm")).toBe(false);
    const clientSourceRows = clientSnapshot.channelMessages.filter(
      (message) =>
        message.channelId === source.dmChannelId &&
        message.metadata &&
        typeof message.metadata === "object" &&
        ("toAgent" in message.metadata || "fromAgent" in message.metadata)
    );
    expect(clientSourceRows.map((message) => message.content)).toEqual(
      sourceProjection.map((message) => message.content)
    );
    const capture = {
      run: "openbot-live-a2a-capture",
      agents: {
        source: { id: sourceId, name: "Source", homeChannelId: source.dmChannelId },
        probe: { id: probeId, name: "Parity Probe", homeChannelId: probe.dmChannelId },
      },
      calls: [
        {
          namespace: "cursor",
          toolName: "SendToAgent",
          arguments: {
            target_id: probeId,
            message: "Live A2A capture from Source. Reply with exactly: ACK",
            images: [{ url: parityImageUrl, alt: "Parity pixel" }],
          },
        },
        {
          namespace: "cursor",
          toolName: "SendToAgent",
          arguments: { target_id: sourceId, message: "ACK" },
        },
      ],
      acknowledgements,
      pairStorage: "two-home-rows-only",
      sourceHomeStore: sourceProjection,
      probeHomeStore: probeProjection,
      modelWakes: peerTurns.map((turn) => ({
        botId: turn.botId,
        role: "user",
        content: turn.content,
      })),
      agentRuns: snapshot.runs.filter((run) => run.origin === "agent"),
      clientSourceHomeStore: clientSourceRows,
    };
    const captureJson = `${JSON.stringify(capture, null, 2)}\n`;
    if (process.env.OPENBOT_A2A_CAPTURE_PATH) {
      await writeFile(process.env.OPENBOT_A2A_CAPTURE_PATH, captureJson, "utf8");
    }
    if (process.env.OPENBOT_A2A_PRINT_CAPTURE === "1") console.log(captureJson.trimEnd());
  } finally {
    if (worker) await worker.stop();
    if (app) await Effect.runPromise(app.close());
    fakeComputer.stop(true);
  }
}, 45_000);
