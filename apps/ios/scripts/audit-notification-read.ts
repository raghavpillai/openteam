/** Production notification service/read API, using only the disposable native-QA database. */
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../../packages/db/src/index";
import { publishChannelNotification } from "../../../packages/messaging/src/notifications";

const prisma = createPrismaClient("postgresql://swiftqa:swiftqa-disposable-only@127.0.0.1:20002/swiftqa_live");
const base = "http://127.0.0.1:20005";
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
const bot = await request("/api/v0/bots", "POST", { name: "Unread audit " + randomUUID().slice(0, 8), clientRequestId: randomUUID() });
try {
  await request(`/api/v0/bots/${bot.id}`, "PATCH", { notificationsEnabled: true });
  for (let i = 0; i < 40; i++) {
    if ((await prisma.channelMessage.count({ where: { channelId: bot.dmChannelId } })) > 0) break;
    await Bun.sleep(250);
  }
  const latest = await prisma.channelMessage.findFirstOrThrow({ where: { channelId: bot.dmChannelId }, orderBy: { sequence: "desc" } });
  await prisma.$transaction(tx => publishChannelNotification(tx, "native-audit-reaction:" + randomUUID(), {
    channelId: bot.dmChannelId, botId: bot.id, kind: "reaction", title: bot.name, body: "QA bot reacted with 👍", messageSequence: latest.sequence.toString(),
  }));
  const before = (await request("/api/v0/client-bootstrap")).channels.find((c: any) => c.id === bot.dmChannelId);
  const nativePayload = { throughSequence: latest.sequence.toString() };
  const nativeRead = await request(`/api/v0/channels/${bot.dmChannelId}/read`, "POST", nativePayload);
  const afterNative = (await request("/api/v0/client-bootstrap")).channels.find((c: any) => c.id === bot.dmChannelId);
  const completePayload = { ...nativePayload, throughNotificationSequence: before.notificationState.notificationCursor };
  const completeRead = await request(`/api/v0/channels/${bot.dmChannelId}/read`, "POST", completePayload);
  const report = { finding: "QA-08", botId: bot.id, channelId: bot.dmChannelId, nativePayload, nativeRead, afterNative: { unreadCount: afterNative.unreadCount, notificationState: afterNative.notificationState }, completePayload, completeRead };
  console.log(JSON.stringify(report, null, 2));
  if (!(afterNative.unreadCount > 0 && completeRead.unreadCount === 0)) throw new Error("The unread-activity defect did not reproduce.");
} finally {
  // Retain the receipt in the disposable database; hide the audit bot and stop alerts.
  // The model-boundary fixture does not implement real desktop deletion.
  await request(`/api/v0/bots/${bot.id}`, "PATCH", { hiddenFromSidebar: true, notificationsEnabled: false });
  await prisma.$disconnect();
}
