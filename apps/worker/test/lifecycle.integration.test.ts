import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { databaseUrl, startStack, type Call, type Turn } from "./fixtures/stack";

const inlineImage = {
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
};
/** The user's text, without the reminder, timestamp, address and file annotation. */
const turnBody = (content: string) => {
  content = content.replace(/^<system_reminder>\n[\s\S]*?\n<\/system_reminder>\n/, "");
  const body = content.match(/^<timestamp>[^\n]+<\/timestamp>\n<user_query>\n([\s\S]*?)\n<\/user_query>(?:\n\n[\s\S]*)?$/)?.[1] ?? content;
  return body.replace(/^\[t\d+u\]\s?/, "").split("\n\nThe user attached a file.")[0]!;
};
const a2a = (metadata: unknown) => Boolean(metadata && typeof metadata === "object" && ("toAgent" in metadata || "fromAgent" in metadata));

test.skipIf(!databaseUrl)("durable bot mailboxes preserve Pi sessions, agent DMs, and ordered group rounds", async () => {
  const cancelled: Array<{ runId: string; reason?: string }> = [];
  const releaseTurn = new Map<string, () => void>();
  let answers = 0;
  let onTurn: (input: Turn, call: Call) => Promise<void> = async () => {};
  const stack = await startStack({
    truncate: true,
    cancel(runId, reason) {
      cancelled.push({ runId, reason });
      releaseTurn.get(runId)?.();
    },
    async turn(input, call) {
      await onTurn(input, call);
      const turnId = input.runId, itemId = `agent-${++answers}`, text = `durable answer ${answers}`;
      const item = { type: "agentMessage", id: itemId, phase: null, memoryCitation: null };
      return { events: [
        { type: "runtime.error", turnId, message: "Transient reconnect", retrying: true },
        { type: "item.started", turnId, item: { ...item, text: "" } },
        { type: "agent.delta", turnId, itemId, delta: text },
        { type: "item.completed", turnId, item: { ...item, text } },
      ] };
    },
  });
  const { root, turns } = stack;
  try {
    let app = stack.app;
    const send = (conversationId: string, input: Record<string, unknown>) =>
      Effect.runPromise(app.sendMessage(conversationId, input as never)) as Promise<{ run: { id: string } }>;
    const completed = (runId: string) => stack.until(async () => (await app.prisma.run.findUnique({ where: { id: runId } }))?.status === "completed", `run ${runId}`);
    const createBot = (clientRequestId: string, name: string) =>
      Effect.runPromise(app.createBot({ clientRequestId, name, icon: name[0], color: "#4f7cff" }));

    const bot = await createBot("create-durable-0001", "Durable");
    expect(bot.status).toBe("provisioning");
    expect((await createBot("create-durable-0001", "Durable")).id).toBe(bot.id);
    expect(await app.prisma.bot.count()).toBe(1);
    const image = await Effect.runPromise(app.uploadAsset({ fileName: "image.png", mimeType: "image/png", bytesBase64: inlineImage.url.split(",")[1]! }));
    const firstInput = { content: "first", clientId: "client-first-0001", attachments: [image], timeZone: "Asia/Jerusalem" };
    const first = await send(bot.conversationId, firstInput);
    expect((await send(bot.conversationId, firstInput)).run.id).toBe(first.run.id);
    await completed(first.run.id);

    const firstSnapshot = await Effect.runPromise(app.snapshot());
    expect(firstSnapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    const [firstTurn] = turns;
    expect(turns).toHaveLength(1);
    expect(firstTurn).toMatchObject({ sessionPath: null, cwd: bot.defaultDirectory, images: [inlineImage] });
    expect(stack.contextReads).toEqual([firstTurn!.contextSessionId]);
    expect(firstTurn!.content).toMatch(/<timestamp>[^\n]+<\/timestamp>\n<user_query>\n\[t\d+u\]\nfirst\n\nThe user attached a file\. They're stored off your box at the paths below[^]*\n<\/user_query>$/);
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", timeZoneName: "shortOffset" })
      .formatToParts(new Date()).find((part) => part.type === "timeZoneName")!.value.replace("GMT", "UTC");
    expect(firstTurn!.content).toContain(`(${offset})</timestamp>`);
    expect(firstTurn!.content).toContain('("image.png", 68 B)');
    expect(firstTurn!.content).toContain(join(root, "data", "agents", bot.id, "attachments", `${image.assetId}.png`));
    expect(firstSnapshot.channelMessages.find((message) => message.channelId === bot.dmChannelId && message.sender === "user"))
      .toMatchObject({ content: "first", metadata: { attachments: [image] } });
    expect("messages" in (await Effect.runPromise(app.clientSnapshot()))).toBe(false);
    expect(firstSnapshot.bots.find((candidate) => candidate.id === bot.id)?.onboardingStatus).toBe("skipped_by_user");
    // Room sessions record their own model and tape; they do not repoint the bot home session
    // or turn a root default into a bot override.
    expect(await app.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } }))
      .toMatchObject({ runtimeEngine: "pi", inferenceProvider: null, inferenceModel: null, runtimeSessionPath: null });
    const recorded = { inferenceProvider: "openai-codex", inferenceModel: "fake" };
    expect(await app.prisma.contextSession.findUniqueOrThrow({ where: { id: firstTurn!.contextSessionId } })).toMatchObject(recorded);
    expect(await app.prisma.run.findUniqueOrThrow({ where: { id: first.run.id } })).toMatchObject(recorded);
    expect(firstSnapshot.workspace).toMatchObject({ root, botsDirectory: join(root, "bots"), sharedDirectory: join(root, "shared") });

    // A recreated host resumes the same Pi tape.
    await stack.shutdown();
    await stack.boot();
    app = stack.app;
    const second = await send(bot.conversationId, { content: "second", clientId: "client-second-0002" });
    await completed(second.run.id);
    const secondSnapshot = await Effect.runPromise(app.snapshot());
    expect(turns.map((turn) => ({ sessionPath: turn.sessionPath, content: turnBody(turn.content), cwd: turn.cwd }))).toEqual([
      { sessionPath: null, content: "first", cwd: bot.defaultDirectory },
      { sessionPath: `/var/lib/openteam/pi/${firstTurn!.contextSessionId}.jsonl`, content: "second", cwd: bot.defaultDirectory },
    ]);
    expect(stack.contextReads).toEqual(turns.map((turn) => turn.contextSessionId));
    expect(secondSnapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(secondSnapshot.runItems.filter((item) => item.runId === second.run.id && item.kind === "error")).toMatchObject([{ status: "completed" }]);

    // A typed message during a running turn supersedes it and runs as a new turn.
    onTurn = async (input) => {
      if (turnBody(input.content) !== "superseded base task") return;
      await new Promise<void>((resolve) => releaseTurn.set(input.runId, resolve));
    };
    const base = await send(bot.conversationId, { content: "superseded base task", clientId: "client-superseded-base-0003" });
    await stack.until(() => releaseTurn.has(base.run.id), "active user turn");
    const redirected = await send(bot.conversationId, { content: "redirect the active task", clientId: "client-superseding-0004", attachments: [image] });
    expect(redirected.run.id).not.toBe(base.run.id);
    await stack.until(() => cancelled.some((cancel) => cancel.runId === base.run.id), "superseded turn cancelled");
    expect(cancelled.find((cancel) => cancel.runId === base.run.id)?.reason).toBe("user_message");
    await stack.until(() => turns.some((turn) => turnBody(turn.content) === "redirect the active task"), "superseding turn");
    expect(turns.find((turn) => turnBody(turn.content) === "redirect the active task")?.images).toEqual([inlineImage]);

    // New bots greet proactively; agent DMs stay hidden and private context is not forwarded.
    let peerId = "";
    onTurn = async (input, call) => {
      if (input.content.includes("[OpenTeam first start]")) {
        await call("SendToUser", { type: "text", content: `Hello from ${input.botId}.` }, `bootstrap-visible-${input.botId}`);
      } else if (input.botId === bot.id && input.content.includes("private alpha instruction")) {
        const handoff = { target_id: peerId, message: "Please verify this handoff.", priority: false };
        await call("SendToAgent", handoff, "direct-send-once");
        expect(await call("SendToAgent", handoff, "direct-send-once")).toBe(
          "Sent to Peer. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now."
        );
        await call("SendToUser", { type: "text", content: "Peer was notified." }, "direct-visible-source");
      } else if (input.botId === peerId && input.content.includes("[agent]")) {
        await call("SendToAgent", { target_id: bot.id, message: "Verified. The handoff works." }, "direct-visible-reply");
      }
    };
    const peer = await createBot("create-peer-0002", "Peer");
    peerId = peer.id;
    const reviewer = await createBot("create-reviewer-0003", "Reviewer");
    await stack.until(async () => (await app.prisma.bot.count({ where: { id: { in: [peer.id, reviewer.id] }, onboardingStatus: "completed" } })) === 2, "proactive onboarding");
    expect(await app.prisma.inboxEvent.count({ where: { botId: { in: [peer.id, reviewer.id] }, type: "bot.bootstrap" } })).toBe(2);
    for (const created of [peer, reviewer])
      expect(await app.prisma.channelMessage.count({ where: { channelId: created.dmChannelId, sender: "agent", content: `Hello from ${created.id}.` } })).toBe(1);

    await completed((await send(bot.conversationId, { content: "private alpha instruction: delegate without sharing this sentence", clientId: "client-direct-0003" })).run.id);
    await stack.until(async () => (await app.prisma.inboxEvent.count({ where: { status: { in: ["pending", "processing"] } } })) === 0, "agent DM wakes");
    const direct = await Effect.runPromise(app.snapshot());
    expect(direct.channels.some((channel) => channel.kind === "agent_dm")).toBe(false);
    const dm = (channelId: string) => direct.channelMessages.filter((message) => message.channelId === channelId);
    expect(dm(bot.dmChannelId).some((message) => message.sender === "agent" && message.content === "Peer was notified.")).toBe(true);
    expect(dm(bot.dmChannelId).filter((message) => a2a(message.metadata)).map(({ content, metadata }) => ({ content, metadata }))).toEqual([
      { content: "Please verify this handoff.", metadata: { toAgent: { id: peer.id, name: "Peer", kind: "agent" } } },
      { content: "Verified. The handoff works.", metadata: { fromAgent: { id: peer.id, name: "Peer" } } },
    ]);
    const peerA2A = dm(peer.dmChannelId).filter((message) => a2a(message.metadata));
    expect(peerA2A.map((message) => message.sender)).toEqual(["user", "agent"]);
    expect(peerA2A[0]?.metadata).toEqual({ fromAgent: { id: bot.id, name: bot.name } });
    expect(direct.messages.some((message) => message.conversationId === peer.conversationId && message.content.includes("private alpha instruction"))).toBe(false);

    // With no worker running, a queued message can be cancelled before it starts.
    await stack.stopWorker();
    const queued = await send(bot.conversationId, { content: "cancel this before it starts", clientId: "client-cancel-queued-0007" });
    expect(await Effect.runPromise(app.cancelRun(queued.run.id))).toMatchObject({ status: "cancelled" });
    expect(await app.prisma.inboxEvent.findUniqueOrThrow({ where: { idempotencyKey: "client-cancel-queued-0007" } })).toMatchObject({ status: "completed" });

    // A group round runs members in order, each in its own room context.
    const group = await Effect.runPromise(app.createGroup({ name: "Ordered room", botIds: [bot.id, peer.id, reviewer.id] }));
    expect(group.workingDirectory).toBe(root);
    await Effect.runPromise(app.updateChannelProfile(group.id, { name: group.name, description: "Coordinate ordered parity checks.", clientId: "group-profile-ordered-checks" }));
    const accepted = (await Effect.runPromise(app.sendChannelMessage(group.id, {
      content: "Give one compact status line.", clientId: "client-group-0004", attachments: [image], timeZone: "Asia/Jerusalem",
    }))) as { round: { id: string } };
    const roundOf = async (input: Turn) =>
      input.deliveryId ? (await app.prisma.channelDelivery.findUnique({ where: { id: input.deliveryId }, select: { roundId: true } }))?.roundId : null;
    onTurn = async (input, call) => {
      // Follow-up peer rounds can start before the first-round assertions run.
      if (input.channelId !== group.id || (await roundOf(input)) !== accepted.round.id) return;
      if (input.botId === bot.id) {
        await call("SendToUser", { type: "text", content: "Private group-turn note.", to: "dm" }, "group-private-dm");
        const wrong = await call("SendToAgent", { target_id: group.id, message: "Wrong group reply primitive." }).catch(String);
        expect(String(wrong)).toContain("Use SendToUser");
      }
      await call("SendToUser", { type: "text", content: `Group answer from ${input.botId}` }, `group-visible-${input.botId}`);
      if (input.botId === bot.id)
        await app.prisma.channelMessage.create({ data: {
          channelId: group.id, sender: "user", clientId: "post-trigger-user-message",
          content: "This arrived after the round trigger and belongs to the next round.",
        } });
    };
    await stack.startWorker();
    await stack.until(async () => (await app.prisma.channelRound.findUnique({ where: { id: accepted.round.id } }))?.status === "completed", "ordered group round");

    const firstRound = new Set((await app.prisma.channelDelivery.findMany({ where: { roundId: accepted.round.id }, select: { id: true } })).map((delivery) => delivery.id));
    const groupTurns = turns.filter((turn) => turn.deliveryId && firstRound.has(turn.deliveryId));
    expect(groupTurns.map((turn) => turn.botId)).toEqual([bot.id, peer.id, reviewer.id]);
    for (const turn of groupTurns) {
      expect(turn).toMatchObject({ cwd: group.workingDirectory, images: [inlineImage], userInfoEpoch: 0 });
      expect(turn.content).toStartWith('[Group chat: "Ordered room"');
      expect(turn.content).toContain("Room: Coordinate ordered parity checks.");
      expect(turn.content).not.toContain("<timestamp>");
      expect(turn.content).not.toContain("belongs to the next round");
      // Teammate and group IDs are in the per-turn user_info catalog.
      expect(turn.userInfo).toStartWith("<user_info>\nToday's date: ");
      expect(turn.userInfo).toEndWith("</available_skills>\n</agent_skills>");
      expect(turn.userInfo).toContain(group.id);
      // Each member gets a fresh room session, separate from its DM session.
      expect(turn.sessionPath).toBeNull();
      expect(turns.find((candidate) => candidate.botId === turn.botId && candidate.channelId !== group.id)?.contextSessionId).not.toBe(turn.contextSessionId);
    }
    expect(new Set(groupTurns.map((turn) => turn.contextSessionId)).size).toBe(3);
    expect(groupTurns[1]!.content).toContain(`Group answer from ${bot.id}`);
    expect(groupTurns[2]!.content).toContain(`Group answer from ${peer.id}`);
    const groupMessages = await app.prisma.channelMessage.findMany({ where: { channelId: group.id }, orderBy: { sequence: "asc" }, select: { content: true } });
    expect(groupMessages.map((message) => message.content)).toEqual([
      "Give one compact status line.",
      "This arrived after the round trigger and belongs to the next round.",
      // Group replies publish at turn completion, after the intervening input.
      `Group answer from ${bot.id}`,
      `Group answer from ${peer.id}`,
      `Group answer from ${reviewer.id}`,
    ]);
    expect(await app.prisma.channelMessage.count({ where: { channelId: bot.dmChannelId, content: "Private group-turn note." } })).toBe(1);
  } finally {
    await stack.close();
  }
}, 180_000);
