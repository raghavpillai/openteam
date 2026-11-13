import { expect } from "bun:test";
import { Effect } from "effect";
import { NotificationService } from "../src/services/notification-service";
import { dbIt } from "./harness";

const device = { platform: "ios" as const, provider: "apns" as const, apnsTopic: "dev.openteam.mobile.swift", notificationScope: "cd".repeat(32) };

dbIt("push registration binds the signing-in session, and sign-out disables only that session's devices", async ({ db, onClose }) => {
  const userId = crypto.randomUUID(), retiring = crypto.randomUUID(), retained = crypto.randomUUID();
  const installationIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  onClose(async () => { await db.pushDevice.deleteMany({ where: { installationId: { in: installationIds } } }); await db.user.deleteMany({ where: { id: userId } }); });
  await db.user.create({ data: { id: userId, name: "Notification QA", email: `${userId}@openteam.invalid` } });
  await db.session.createMany({ data: [retiring, retained].map(id => ({ id, userId, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) })) });
  const service = new NotificationService(db);
  const token = () => crypto.randomUUID().replaceAll("-", "").repeat(2);
  // Registration binds a required-auth device to the session that signed it in.
  await Effect.runPromise(service.register({ ...device, installationId: installationIds[0]!, pushToken: "AB".repeat(32), apnsEnvironment: "production" }, { mode: "required", sessionId: retiring } as never));
  await db.pushDevice.createMany({ data: [retained, null].map((sessionId, index) => ({
    ...device, installationId: installationIds[index + 1]!, pushToken: token(), apnsEnvironment: "production", authRequired: !!sessionId, authSessionId: sessionId, enabled: true,
  })) });
  // A rotated APNs token is stored normalized.
  expect(await db.pushDevice.findUniqueOrThrow({ where: { installationId: installationIds[0]! } })).toMatchObject({ pushToken: "ab".repeat(32), authRequired: true, authSessionId: retiring, enabled: true });
  expect(await Effect.runPromise(service.disableForSession(retiring))).toEqual({ disabledCount: 1 });
  const devices = await db.pushDevice.findMany({ where: { installationId: { in: installationIds } } });
  expect(installationIds.map(id => devices.find(row => row.installationId === id)?.enabled)).toEqual([false, true, true]);
  expect(await Effect.runPromise(service.disableForSession(retiring))).toEqual({ disabledCount: 0 });
}, 30_000);

dbIt("a read cursor advances but never regresses, and peer-agent rows are not unread", async ({ db, bot }) => {
  const { id: botId, channelId } = await bot("Reader");
  const add = (data: Record<string, unknown>) => db.channelMessage.create({ data: { channelId: channelId!, sender: "agent", senderBotId: botId, content: "x", ...data } });
  const read = await add({ content: "Already read" });
  await add({ content: "New reply", metadata: { type: "text" } });
  await add({ content: "Peer chatter", metadata: { fromAgent: { id: "peer" } } });
  const service = new NotificationService(db);
  expect(await Effect.runPromise(service.markChannelRead(channelId!, String(read.sequence)))).toMatchObject({ channelId, lastReadSequence: String(read.sequence), unreadCount: 1 });
  expect(await Effect.runPromise(service.markChannelRead(channelId!, String(read.sequence - 1n)))).toMatchObject({ lastReadSequence: String(read.sequence) });
});
