import type { NotificationRouting } from "@openteam/contracts/notification-presence";
import type { Prisma } from "@openteam/db";

/** OpenTeam provisions one owner per deployment, as do channel reads and bot preferences. */
export async function notificationRouting(
  db: Pick<Prisma.TransactionClient, "notificationPresence" | "notificationPreferences">,
  authMode: "required" | "disabled",
  now = new Date()
): Promise<NotificationRouting> {
  const [preferences, presence] = await Promise.all([
    db.notificationPreferences.findUnique({ where: { id: "global" } }),
    db.notificationPresence.findMany({
      where: {
        expiresAt: { gt: now },
        ...(authMode === "disabled"
          ? { authRequired: false }
          : {
              authRequired: true,
              authSession: { is: { expiresAt: { gt: now } } },
            }),
      },
      select: { platform: true, expiresAt: true },
    }),
  ]);
  const until = (platform: string) =>
    Math.max(
      0,
      ...presence.filter((row) => row.platform === platform).map((row) => row.expiresAt.getTime())
    );
  return {
    smartEnabled: preferences?.smartEnabled ?? true,
    serverTime: now.getTime(),
    iosActiveUntil: until("ios"),
    macActiveUntil: until("macos"),
  };
}
