import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import {
  type AgentNotificationPayload,
  type ChannelNotificationState,
  type ChannelNotificationView,
  agentNotificationPresentation,
  notificationMessageInputReason,
  notificationMessagePreview,
  truncateNotificationText,
} from "@openteam/contracts";
import { Prisma } from "@openteam/db";

type NotificationInput = Omit<AgentNotificationPayload, "badgeCount" | "notificationSequence">;

/** Persist activity once, then fan out the same identity to every registered device. */
export const publishChannelNotification = async (
  tx: Prisma.TransactionClient,
  key: string,
  input: NotificationInput
): Promise<void> => {
  input = {
    ...input,
    title: truncateNotificationText(input.title),
    body: truncateNotificationText(input.body),
  };
  const [bot, channel] = await Promise.all([
    tx.bot.findUnique({ where: { id: input.botId } }),
    tx.channel.findUnique({ where: { id: input.channelId } }),
  ]);
  if (
    !bot ||
    !bot.notificationsEnabled ||
    bot.hiddenFromSidebar ||
    !channel ||
    channel.archivedAt ||
    channel.hiddenFromSidebar ||
    channel.kind === "agent_dm"
  )
    return;
  input = {
    ...input,
    title: truncateNotificationText(bot.name),
    sender: {
      name: truncateNotificationText(bot.name),
      icon: normalizeRobotAvatarShape(bot.icon),
      color: /^#[0-9a-f]{6}$/i.test(bot.color) ? bot.color : "#4f7cff",
    },
  };
  // Serialize activity allocation with reads in this channel. NO KEY UPDATE is
  // compatible with the foreign-key locks already held by message inserts.
  await tx.$executeRaw`SELECT 1 FROM "Channel" WHERE id = ${input.channelId}::uuid FOR NO KEY UPDATE`;
  const created = await tx.channelNotification.createMany({
    data: {
      key,
      channelId: input.channelId,
      botId: input.botId,
      kind: input.kind,
      messageSequence: input.messageSequence ? BigInt(input.messageSequence) : null,
      payload: input as unknown as Prisma.InputJsonValue,
    },
    skipDuplicates: true,
  });
  if (!created.count) return;
  const activity = await tx.channelNotification.findUniqueOrThrow({ where: { key } });
  const payload: AgentNotificationPayload = {
    ...input,
    notificationSequence: activity.sequence.toString(),
    badgeCount: 0,
  };
  await tx.event.create({
    data: {
      topic: "notification.created",
      entityId: input.channelId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
  const disabledAuth = process.env.OPENTEAM_AUTH_MODE?.trim().toLowerCase() === "disabled";
  const devices = await tx.pushDevice.findMany({
    where: disabledAuth
      ? { enabled: true, authRequired: false }
      : {
          enabled: true,
          authRequired: true,
          authSession: { is: { expiresAt: { gt: new Date() } } },
        },
    select: { id: true },
  });
  if (devices.length)
    await tx.outboxDelivery.createMany({
      data: devices.map(({ id }) => ({
        deliveryKey: `notification:activity:${activity.sequence}:${id}`,
        topic: "push.notification",
        target: id,
        payload: payload as unknown as Prisma.InputJsonValue,
        // Let the foreground client's read receipt overtake an alert before it is sent.
        availableAt: new Date(Date.now() + 1_500),
      })),
      skipDuplicates: true,
    });
};

export const publishMessageNotification = async (
  tx: Prisma.TransactionClient,
  message: {
    id: string;
    channelId: string;
    sequence: bigint;
    senderBotId: string | null;
    sourceRunId: string | null;
    content: string;
    metadata: unknown;
  }
): Promise<void> => {
  if (!message.senderBotId) return;
  if (
    message.metadata &&
    typeof message.metadata === "object" &&
    ("fromAgent" in message.metadata || "toAgent" in message.metadata)
  )
    return;
  const bot = await tx.bot.findUnique({
    where: { id: message.senderBotId },
    select: { name: true },
  });
  if (!bot) return;
  const reason = notificationMessageInputReason(message);
  const kind = reason ? "agent-needs-input" : "message";
  const { title, body } = agentNotificationPresentation({
    kind,
    botName: bot.name,
    body: reason ?? notificationMessagePreview(message),
  });
  await publishChannelNotification(tx, `message:${message.id}`, {
    schemaVersion: 1,
    kind,
    botId: message.senderBotId,
    channelId: message.channelId,
    runId: message.sourceRunId ?? "",
    messageSequence: message.sequence.toString(),
    title,
    body,
    deepLink: `openteam:///chat/${message.channelId}`,
  });
};

/** Bounded alert history plus durable read markers; missing history never means read. */
export const channelNotificationStates = async (
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  channelIds: string[]
): Promise<Map<string, ChannelNotificationState>> => {
  if (!channelIds.length) return new Map();
  const rows = await tx.$queryRaw<
    Array<{
      channelId: string;
      lastReadSequence: bigint;
      lastReadNotificationSequence: bigint;
      notificationCursor: bigint;
      notifications: ChannelNotificationView[];
      activityUnreadCount: bigint;
    }>
  >(Prisma.sql`
    SELECT requested."channelId", COALESCE(state."lastReadSequence", 0) AS "lastReadSequence",
      COALESCE(state."lastReadNotificationSequence", 0) AS "lastReadNotificationSequence",
      COALESCE((SELECT MAX(n."sequence") FROM "ChannelNotification" n
        WHERE n."channelId" = requested."channelId"), 0) AS "notificationCursor",
      COALESCE((SELECT jsonb_agg(alert.payload || jsonb_build_object('notificationSequence', alert.sequence::text))
        FROM (SELECT n.payload, n.sequence FROM "ChannelNotification" n
          JOIN "Bot" bot ON bot.id = n."botId"
          WHERE n."channelId" = requested."channelId" AND NOT n.revoked
            AND bot."notificationsEnabled" AND NOT bot."hiddenFromSidebar"
            AND CASE WHEN n.kind = 'reaction' OR n."messageSequence" IS NULL
              THEN n.sequence > COALESCE(state."lastReadNotificationSequence", 0)
              ELSE n."messageSequence" > COALESCE(state."lastReadSequence", 0) END
          ORDER BY n.sequence DESC LIMIT 100) alert), '[]'::jsonb) AS notifications,
      (SELECT COUNT(*) FROM "ChannelNotification" n WHERE n."channelId" = requested."channelId"
        AND NOT n.revoked AND (n.kind = 'reaction' OR n."messageSequence" IS NULL)
        AND EXISTS (SELECT 1 FROM "Bot" b WHERE b.id = n."botId" AND b."notificationsEnabled" AND NOT b."hiddenFromSidebar")
        AND n.sequence > COALESCE(state."lastReadNotificationSequence", 0)) AS "activityUnreadCount"
    FROM unnest(${channelIds}::uuid[]) requested("channelId")
    LEFT JOIN "ChannelReadState" state ON state."channelId" = requested."channelId"
  `);
  return new Map(
    rows.map((row) => [
      row.channelId,
      {
        ...row,
        lastReadSequence: row.lastReadSequence.toString(),
        lastReadNotificationSequence: row.lastReadNotificationSequence.toString(),
        notificationCursor: row.notificationCursor.toString(),
        activityUnreadCount: Number(row.activityUnreadCount),
      },
    ])
  );
};
