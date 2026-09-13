import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { NotificationService } from "../src/services/notification-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "sign-out disables only the retiring session's devices with a real PostgreSQL lock",
  async () => {
    if (!databaseUrl) throw new Error("OPENTEAM_TEST_DATABASE_URL is required");
    const prisma = createPrismaClient(databaseUrl);
    const userId = crypto.randomUUID();
    const retiringSessionId = crypto.randomUUID();
    const retainedSessionId = crypto.randomUUID();
    const installationIds = Array.from({ length: 3 }, () => crypto.randomUUID());
    try {
      await prisma.user.create({
        data: { id: userId, name: "Notification QA", email: `${userId}@openteam.invalid` },
      });
      await prisma.session.createMany({
        data: [retiringSessionId, retainedSessionId].map((id) => ({
          id,
          userId,
          token: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        })),
      });
      await prisma.pushDevice.createMany({
        data: installationIds.map((installationId, index) => ({
          installationId,
          platform: "ios" as const,
          pushToken: `ExpoPushToken[${crypto.randomUUID()}]`,
          authRequired: index < 2,
          authSessionId: index === 0 ? retiringSessionId : index === 1 ? retainedSessionId : null,
          enabled: true,
        })),
      });
      const service = new NotificationService(prisma);
      await expect(
        Effect.runPromise(service.disableForSession(retiringSessionId))
      ).resolves.toEqual({
        disabledCount: 1,
      });
      const devices = await prisma.pushDevice.findMany({
        where: { installationId: { in: installationIds } },
      });
      expect(
        installationIds.map((id) => devices.find((device) => device.installationId === id)?.enabled)
      ).toEqual([false, true, true]);
      await expect(
        Effect.runPromise(service.disableForSession(retiringSessionId))
      ).resolves.toEqual({
        disabledCount: 0,
      });
    } finally {
      await prisma.pushDevice.deleteMany({ where: { installationId: { in: installationIds } } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
  },
  30_000
);
