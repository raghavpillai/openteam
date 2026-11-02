import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { notificationRouting, publishMessageNotification } from "@openteam/messaging";
import {
  suppressMobileNotification,
  type NotificationPresenceInput,
} from "@openteam/contracts/notification-presence";
import { NotificationService } from "../../server/src/services/notification-service";
import { PushNotificationDispatcher } from "../src/push-notifications";
import type { ApnsClient } from "../src/apns";
import { SnapshotService } from "../../server/src/services/snapshot-service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!url)(
  "PostgreSQL presence gates every iPhone, preserves badge sync, and never replays suppressed activity",
  async () => {
    const db = createPrismaClient(url!);
    const workerDb = createPrismaClient(url!); // independent process/connection state
    const service = new NotificationService(db, "disabled");
    const previousAuth = process.env.OPENTEAM_AUTH_MODE;
    process.env.OPENTEAM_AUTH_MODE = "disabled";
    const mac = crypto.randomUUID(),
      phone = crypto.randomUUID();
    const deviceIds = [crypto.randomUUID(), crypto.randomUUID()];
    const botId = crypto.randomUUID(),
      channelId = crypto.randomUUID();
    const firstPhone: string[] = [],
      secondPhone: string[] = [];
    const apns = {
      send: async (device: { id: string }, payload: { kind: string }) => {
        (device.id === deviceIds[0] ? firstPhone : secondPhone).push(payload.kind);
        return { status: 200 };
      },
    } as unknown as ApnsClient;
    const dispatcher = new PushNotificationDispatcher(workerDb, "disabled", apns);
    const presence = (clientId: string, sequence: number, active: boolean, idleSeconds = 0) =>
      Effect.runPromise(
        service.updatePresence(
          { clientId, sequence, active, idleSeconds, platform: clientId === mac ? "macos" : "ios" },
          { mode: "disabled" }
        )
      );
    const drain = async () => {
      await db.outboxDelivery.updateMany({
        where: { topic: "push.notification", target: { in: deviceIds }, status: "pending" },
        data: { availableAt: new Date(0) },
      });
      await dispatcher.drain();
      expect(
        await db.outboxDelivery.count({ where: { target: { in: deviceIds }, status: "failed" } })
      ).toBe(0);
    };
    let messageNumber = 0;
    const message = () =>
      db.$transaction(async (tx) => {
        const row = await tx.channelMessage.create({
          data: {
            channelId,
            sender: "agent",
            senderBotId: botId,
            content: `Message ${++messageNumber}`,
          },
        });
        await publishMessageNotification(tx, row);
        return row;
      });
    try {
      await db.bot.create({ data: { id: botId, name: "Presence test", defaultDirectory: "/tmp" } });
      await db.channel.create({ data: { id: channelId, name: "Presence test", kind: "bot_dm" } });
      await db.pushDevice.createMany({
        data: deviceIds.map((id) => ({
          id,
          installationId: id,
          platform: "ios",
          provider: "apns",
          pushToken: id.replaceAll("-", "").repeat(2),
          apnsEnvironment: "production",
          apnsTopic: "dev.openteam.mobile.swift",
          notificationScope: "cd".repeat(32),
          authRequired: false,
        })),
      });
      await Effect.runPromise(service.updatePreferences(true));
      await presence(mac, 1, true);
      const first = await message();
      await drain();
      expect(firstPhone).toEqual([]);
      expect(secondPhone).toEqual([]);
      expect(await db.channelReadState.findUnique({ where: { channelId } })).toBeNull();
      expect(
        await db.outboxDelivery.count({
          where: { target: { in: deviceIds }, topic: "push.notification", status: "delivered" },
        })
      ).toBe(2);

      // Reading remains synchronized even while the Mac suppresses mobile alerts.
      await Effect.runPromise(service.markChannelRead(channelId, first.sequence.toString()));
      await drain();
      expect(firstPhone).toEqual(["badge-sync"]);
      expect(secondPhone).toEqual(["badge-sync"]);
      firstPhone.length = 0;
      secondPhone.length = 0;

      // Explicit foreground-phone priority prevents mutual suppression.
      await presence(phone, 1, true);
      const snapshots = new SnapshotService(
        db,
        "/tmp",
        "http://127.0.0.1:1",
        () => true,
        1,
        undefined,
        undefined,
        "disabled"
      );
      const bootstrap = await Effect.runPromise(snapshots.bootstrap());
      expect(bootstrap.notificationRouting!.iosActiveUntil).toBeGreaterThan(
        bootstrap.notificationRouting!.serverTime
      );
      await message();
      await drain();
      expect(firstPhone).toEqual(["message"]);
      expect(secondPhone).toEqual(["message"]);
      await presence(phone, 3, false);
      await presence(phone, 2, true); // delayed heartbeat cannot revive the phone
      expect((await notificationRouting(workerDb, "disabled")).iosActiveUntil).toBe(0);
      await message();
      await drain();
      expect(firstPhone).toHaveLength(1);

      // Exact five-minute boundary; moving the mouse in another app counts before it.
      await presence(mac, 2, true, 300);
      await message();
      await drain();
      expect(firstPhone).toHaveLength(2);
      await presence(mac, 3, true, 299);
      const lease = await db.notificationPresence.findUniqueOrThrow({ where: { clientId: mac } });
      expect(lease.expiresAt.getTime() - lease.updatedAt.getTime()).toBe(1_000);
      expect(
        suppressMobileNotification(await notificationRouting(workerDb, "disabled", lease.expiresAt))
      ).toBeFalse();
      await presence(mac, 4, true);
      await presence(mac, 5, false); // lock/sleep/quit release
      await message();
      await drain();
      expect(firstPhone).toHaveLength(3);
      await presence(mac, 6, true);
      await db.notificationPresence.update({
        where: { clientId: mac },
        data: { expiresAt: new Date(0) },
      });
      await message();
      await drain();
      expect(firstPhone).toHaveLength(4);
      await presence(mac, 7, true);
      await Effect.runPromise(service.updatePreferences(false));
      await message();
      await drain();
      expect(firstPhone).toHaveLength(5);
      expect(secondPhone).toHaveLength(5);
      await presence(mac, 8, false);
      await drain();
      expect(firstPhone).toHaveLength(5); // no backlog replay on handoff
    } finally {
      process.env.OPENTEAM_AUTH_MODE = previousAuth;
      await db.notificationPresence.deleteMany({ where: { clientId: { in: [mac, phone] } } });
      await db.notificationPreferences.deleteMany({ where: { id: "global" } });
      await db.outboxDelivery.deleteMany({ where: { target: { in: deviceIds } } });
      await db.pushDevice.deleteMany({ where: { id: { in: deviceIds } } });
      await db.channel.deleteMany({ where: { id: channelId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await workerDb.$disconnect();
      await db.$disconnect();
    }
  },
  30_000
);

test.skipIf(!url)(
  "presence is auth-mode/session bound, ordered across connections, and retired before sign-out",
  async () => {
    const db = createPrismaClient(url!);
    const second = createPrismaClient(url!);
    const service = new NotificationService(db);
    const userId = crypto.randomUUID(),
      sessionId = crypto.randomUUID(),
      otherSession = crypto.randomUUID();
    const clientId = crypto.randomUUID(),
      disabledId = crypto.randomUUID();
    const input: NotificationPresenceInput = {
      clientId,
      sequence: 1,
      platform: "macos",
      active: true,
      idleSeconds: 0,
    };
    try {
      await db.user.create({
        data: { id: userId, name: "Presence test", email: `${userId}@test.invalid` },
      });
      await db.session.createMany({
        data: [sessionId, otherSession].map((id) => ({
          id,
          userId,
          token: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 600_000),
        })),
      });
      const auth = { mode: "required" as const, sessionId };
      await Effect.runPromise(service.updatePresence(input, auth));
      expect(suppressMobileNotification(await notificationRouting(second, "required"))).toBeTrue();
      expect(suppressMobileNotification(await notificationRouting(second, "disabled"))).toBeFalse();
      await Effect.runPromise(
        service.updatePresence(
          { ...input, sequence: 50, active: false },
          { mode: "required", sessionId: otherSession }
        )
      );
      expect(suppressMobileNotification(await notificationRouting(second, "required"))).toBeTrue();
      await Promise.all([
        Effect.runPromise(service.updatePresence({ ...input, sequence: 2 }, auth)),
        Effect.runPromise(
          new NotificationService(second).updatePresence(
            { ...input, sequence: 3, active: false },
            auth
          )
        ),
      ]);
      expect(
        (await db.notificationPresence.findUniqueOrThrow({ where: { clientId } })).sequence
      ).toBe(3);
      expect(suppressMobileNotification(await notificationRouting(second, "required"))).toBeFalse();
      await Effect.runPromise(service.updatePresence({ ...input, sequence: 4 }, auth));
      await Effect.runPromise(service.disableForSession(sessionId));
      await Effect.runPromise(service.updatePresence({ ...input, sequence: 5 }, auth));
      expect(suppressMobileNotification(await notificationRouting(second, "required"))).toBeFalse();
      await db.session.update({ where: { id: sessionId }, data: { expiresAt: new Date(0) } });
      await expect(Effect.runPromise(service.updatePresence(input, auth))).rejects.toThrow(
        "Sign in"
      );
      await expect(
        Effect.runPromise(service.updatePresence(input, { mode: "disabled" }))
      ).rejects.toThrow("Refresh authentication");
      await Effect.runPromise(
        new NotificationService(db, "disabled").updatePresence(
          { ...input, clientId: disabledId },
          { mode: "disabled" }
        )
      );
      expect(suppressMobileNotification(await notificationRouting(second, "required"))).toBeFalse();
      expect(suppressMobileNotification(await notificationRouting(second, "disabled"))).toBeTrue();
    } finally {
      await db.notificationPresence.deleteMany({
        where: { clientId: { in: [clientId, disabledId] } },
      });
      await db.user.deleteMany({ where: { id: userId } });
      await second.$disconnect();
      await db.$disconnect();
    }
  },
  30_000
);
