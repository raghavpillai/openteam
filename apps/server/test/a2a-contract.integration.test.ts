import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { AppService } from "../src/app-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test("source-verified Bot A2A errors, group rows, and channel updates run end to end", async () => {
  if (!databaseUrl) return;

  const workspace = join(tmpdir(), `openteam-a2a-contract-${crypto.randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  const fakeComputer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
      }
      if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/v1/workspaces/")) {
        return Response.json({ ok: true });
      }
      if (request.method === "PUT" && url.pathname === "/v1/directories") {
        return Response.json({ directories: [] });
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
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.OPENTEAM_COMPUTER_URL = `http://127.0.0.1:${fakeComputer.port}`;
  process.env.OPENTEAM_CONTROL_TOKEN = "a2a-contract-control-token";
  process.env.OPENTEAM_WORKSPACE_ROOT = workspace;
  process.env.OPENTEAM_AGENT_DATA_ROOT = join(workspace, "agent-data");

  const app = new AppService();
  try {
    await app.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Computer", "Bot", "OutboxDelivery", "Event", "IdempotencyRecord" CASCADE'
    );
    await Effect.runPromise(app.boot());
    const source = await Effect.runPromise(
      app.createBot({ clientRequestId: "a2a-contract-source", name: "Source" })
    );
    const peer = await Effect.runPromise(
      app.createBot({ clientRequestId: "a2a-contract-peer", name: "Peer" })
    );
    const outsider = await Effect.runPromise(
      app.createBot({ clientRequestId: "a2a-contract-outsider", name: "Outsider" })
    );
    await app.prisma.bot.updateMany({
      where: { id: { in: [source.id, peer.id, outsider.id] } },
      data: { status: "active", onboardingStatus: "completed" },
    });

    const sourceTurn = (await Effect.runPromise(
      app.sendMessage(source.conversationId, {
        content: "Prepare A2A contract probes.",
        clientId: "a2a-contract-source-turn",
      })
    )) as { run: { id: string } };
    const outsiderTurn = (await Effect.runPromise(
      app.sendMessage(outsider.conversationId, {
        content: "Prepare membership probe.",
        clientId: "a2a-contract-outsider-turn",
      })
    )) as { run: { id: string } };
    const context = {
      runId: sourceTurn.run.id,
      botId: source.id,
      conversationId: source.conversationId,
      channelId: source.dmChannelId,
      deliveryId: null,
      origin: "user" as const,
      callId: "a2a-contract-call",
      replyToMessageId: null,
      isFork: false,
    };

    await expect(
      app.messaging.sendToAgent(context, { target_id: source.id, message: "self" })
    ).rejects.toThrow(
      "You can't message yourself with SendToAgent. Use SendToUser to talk to the user, or pick a different target id."
    );
    const missingId = crypto.randomUUID();
    await expect(
      app.messaging.sendToAgent(
        { ...context, callId: "a2a-missing" },
        { target_id: missingId, message: "missing" }
      )
    ).rejects.toThrow(`No agent found with id ${missingId}.`);
    await expect(
      app.messaging.sendToAgent(
        { ...context, callId: "a2a-not-group" },
        { target_id: source.dmChannelId, message: "not a group" }
      )
    ).rejects.toThrow(`${source.dmChannelId} is not a group chat.`);

    const createAck = await app.administration.createChannel(source.id, "create-contract-room", {
      name: "Contract room",
      member_ids: [source.id, peer.id],
    });
    const groupId = createAck.match(/\(id: ([^)]+)\)/)?.[1];
    if (!groupId) throw new Error("CreateChannel did not return a group id");
    expect(createAck).toBe(
      `Channel "Contract room" is ready (id: ${groupId}). Members: Source, Peer. Post into it with SendToAgent using that id.`
    );
    const profiledGroup = (await Effect.runPromise(
      app.updateChannelProfile(groupId, {
        name: "Contract room",
        description: "Coordinate exact A2A contract checks.",
        clientId: "a2a-contract-group-profile",
      })
    )) as { description: string };
    expect(profiledGroup.description).toBe("Coordinate exact A2A contract checks.");
    expect(
      JSON.parse(
        await readFile(join(workspace, "agent-data", "agents", groupId, "profile.json"), "utf8")
      )
    ).toEqual({ name: "Contract room", description: "Coordinate exact A2A contract checks." });
    const avatarPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlXYEAAAAASUVORK5CYII=";
    const groupWithAvatar = await Effect.runPromise(
      app.setChannelAvatar(groupId, {
        pngBase64: avatarPngBase64,
        clientId: "a2a-contract-group-avatar",
      })
    );
    expect(groupWithAvatar.hasAvatar).toBe(true);
    const storedAvatar = await Effect.runPromise(app.channelAvatar(groupId));
    expect(storedAvatar.contentType).toBe("image/png");
    expect(storedAvatar.bytes).toEqual(Buffer.from(avatarPngBase64, "base64"));
    const groupWithoutAvatar = await Effect.runPromise(
      app.setChannelAvatar(groupId, {
        pngBase64: null,
        clientId: "a2a-contract-group-avatar-clear",
      })
    );
    expect(groupWithoutAvatar.hasAvatar).toBe(false);
    await expect(Effect.runPromise(app.channelAvatar(groupId))).rejects.toThrow(
      "Group has no avatar"
    );

    const leaseRun = async (input: {
      botId: string;
      conversationId: string;
      channelId: string;
      origin: "user" | "group";
    }) =>
      app.prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            botId: input.botId,
            conversationId: input.conversationId,
            role: "user",
            content: "Active lane fixture",
            status: "completed",
          },
        });
        const run = await tx.run.create({
          data: {
            botId: input.botId,
            conversationId: input.conversationId,
            userMessageId: message.id,
            status: "running",
            origin: input.origin,
            channelId: input.channelId,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        await tx.botRunLease.create({
          data: {
            botId: input.botId,
            runId: run.id,
            ownerId: "a2a-contract-test",
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        return run;
      });

    const nonUserRun = await leaseRun({
      botId: peer.id,
      conversationId: peer.conversationId,
      channelId: groupId,
      origin: "group",
    });
    const priorityInterrupt = await app.messaging.sendToAgent(
      { ...context, callId: "a2a-priority-interrupt" },
      { target_id: peer.id, message: "Stop and check this.", priority: true }
    );
    expect(priorityInterrupt.interruptRunId).toBe(nonUserRun.id);
    const interruptedWake = await app.prisma.message.findFirstOrThrow({
      where: { botId: peer.id, clientId: `agent:a2a-priority-interrupt:${peer.id}` },
    });
    expect(interruptedWake.content).toStartWith("<timestamp>");
    expect(interruptedWake.content).toContain(
      "It interrupted your previous non-user work. Drop conflicting in-flight work and follow it now."
    );
    await app.prisma.botRunLease.delete({ where: { botId: peer.id } });

    const userRun = await leaseRun({
      botId: outsider.id,
      conversationId: outsider.conversationId,
      channelId: outsider.dmChannelId,
      origin: "user",
    });
    const priorityQueued = await app.messaging.sendToAgent(
      { ...context, callId: "a2a-priority-user-lane" },
      { target_id: outsider.id, message: "Handle this after the user.", priority: true }
    );
    expect(priorityQueued.interruptRunId).toBeNull();
    const queuedWake = await app.prisma.message.findFirstOrThrow({
      where: { botId: outsider.id, clientId: `agent:a2a-priority-user-lane:${outsider.id}` },
    });
    expect(queuedWake.content).toContain(
      "Handle it ahead of other non-user work. Your user can already see it in this chat."
    );
    expect(
      await app.prisma.botRunLease.findUniqueOrThrow({ where: { botId: outsider.id } })
    ).toMatchObject({ runId: userRun.id });

    await expect(
      app.messaging.sendToAgent(
        {
          ...context,
          runId: outsiderTurn.run.id,
          botId: outsider.id,
          conversationId: outsider.conversationId,
          channelId: outsider.dmChannelId,
          callId: "a2a-non-member",
        },
        { target_id: groupId, message: "not seated" }
      )
    ).rejects.toThrow("You can only post to a group you're a member of.");

    expect(
      await app.messaging.sendToAgent(
        { ...context, callId: "a2a-group-empty" },
        { target_id: groupId, message: "   " }
      )
    ).toMatchObject({ acknowledgement: "Message was empty; nothing was sent." });
    expect(
      await app.messaging.sendToAgent(
        { ...context, callId: "a2a-group-pass" },
        { target_id: groupId, message: "(pass)" }
      )
    ).toMatchObject({
      acknowledgement: 'Nothing was posted: "(pass)" means staying silent in a group chat.',
    });

    const posted = await app.messaging.sendToAgent(
      { ...context, callId: "a2a-group-post" },
      {
        target_id: groupId,
        message: "Group contract payload",
        images: [{ url: "https://example.com/not-delivered.png" }],
        priority: true,
      }
    );
    expect(posted).toMatchObject({
      acknowledgement:
        'Posted to "Contract room". Its members will see it and reply on their own turns. Note: the attached image was NOT delivered — group messages are text-only for now; send images to an agent directly.',
      interruptRunId: null,
    });
    const groupRow = await app.prisma.channelMessage.findFirstOrThrow({
      where: { channelId: groupId, content: "Group contract payload" },
    });
    expect(groupRow.metadata).toEqual({
      kind: "send-message",
      author: { id: source.id, name: "Source" },
      message: { type: "text", content: "Group contract payload" },
    });
    const senderMirror = await app.prisma.channelMessage.findFirstOrThrow({
      where: { channelId: source.dmChannelId, content: "Group contract payload" },
    });
    expect(senderMirror.metadata).toEqual({
      toAgent: { id: groupId, name: "Contract room", kind: "group" },
    });

    const groupTurn = (await Effect.runPromise(
      app.sendMessage(source.conversationId, {
        content: "Synthetic bound group-turn run.",
        clientId: "a2a-contract-group-turn",
      })
    )) as { run: { id: string } };
    const groupTurnContext = {
      ...context,
      runId: groupTurn.run.id,
      channelId: groupId,
      deliveryId: crypto.randomUUID(),
    };
    expect(
      await app.messaging.sendVisible(
        { ...groupTurnContext, callId: "group-private-dm" },
        { type: "text", content: "Private note", to: "dm" }
      )
    ).toMatchObject({ acknowledgement: { sent: true, channel_type: "bot_dm" } });
    for (let index = 1; index <= 3; index += 1) {
      expect(
        await app.messaging.sendVisible(
          { ...groupTurnContext, callId: `group-visible-${index}` },
          { type: "text", content: `Visible room reply ${index}` }
        )
      ).toMatchObject({ acknowledgement: { sent: true, channel_type: "group" } });
    }
    await expect(
      app.messaging.sendVisible(
        { ...groupTurnContext, callId: "group-visible-over-limit" },
        { type: "text", content: "Fourth room reply" }
      )
    ).rejects.toThrow(
      "Not delivered — you've reached this room turn's 3-message limit. Consolidate, or wait for your next turn."
    );

    expect(
      await app.administration.updateChannel(source.id, "channel-noop", {
        channel_id: groupId,
      })
    ).toBe("Nothing to change: provide add_member_ids and/or remove_member_ids.");
    expect(
      await app.administration.updateChannel(source.id, "channel-empty", {
        channel_id: groupId,
        remove_member_ids: [source.id, peer.id],
      })
    ).toBe("A channel needs at least one member, so this removal was not applied.");
    expect(await app.prisma.channelMember.count({ where: { channelId: groupId } })).toBe(2);
    expect(
      await app.administration.updateChannel(source.id, "channel-remove-wins", {
        channel_id: groupId,
        add_member_ids: [peer.id],
        remove_member_ids: [peer.id],
      })
    ).toBe(`Updated channel "Contract room" (id: ${groupId}). Members: Source.`);
    await expect(
      app.administration.updateChannel(outsider.id, "channel-not-found", {
        channel_id: groupId,
        add_member_ids: [outsider.id],
      })
    ).rejects.toThrow(`No channel found with id ${groupId}.`);
  } finally {
    await Effect.runPromise(app.close());
    fakeComputer.stop(true);
  }
}, 45_000);
