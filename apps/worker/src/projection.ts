import type { ComputerEvent } from "@openbot/contracts";
import type { Prisma, PrismaClient, RunItemKind, RunItemStatus } from "@openbot/db";
import type { AgentDataStore } from "@openbot/messaging";

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const itemType = (item: Record<string, unknown>): RunItemKind => {
  switch (item.type) {
    case "agentMessage":
      return "agent_message";
    case "reasoning":
    case "plan":
      return "reasoning";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_change";
    case "contextCompaction":
      return "compaction";
    default:
      return "tool";
  }
};

const itemStatus = (item: Record<string, unknown>, completed: boolean): RunItemStatus => {
  if (completed) {
    const status = String(item.status ?? "completed").toLowerCase();
    if (status.includes("fail")) return "failed";
    if (status.includes("cancel") || status.includes("declin")) return "cancelled";
    return "completed";
  }
  return "running";
};

export class Projection {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly agentData?: AgentDataStore
  ) {}

  async apply(runId: string, conversationId: string, botId: string, event: ComputerEvent) {
    switch (event.type) {
      case "session.attached":
        await this.prisma.$transaction(async (tx) => {
          const bot = await tx.bot.findUniqueOrThrow({
            where: { id: botId },
          });
          const contextSession = await tx.contextSession.findUniqueOrThrow({
            where: { id: event.contextSessionId },
          });
          if (contextSession.botId !== botId) {
            throw new Error("Runtime attempted to attach another bot's context session");
          }
          if (bot.runtimeProvider !== event.provider) {
            throw new Error("Runtime attempted to replace the bot's immutable provider");
          }
          if (
            contextSession.runtimeSessionPath &&
            contextSession.runtimeSessionPath !== event.sessionPath
          ) {
            throw new Error("Runtime attempted to replace an immutable context session");
          }
          if (
            contextSession.runtimeSessionId &&
            contextSession.runtimeSessionId !== event.sessionId
          ) {
            throw new Error("Runtime attempted to replace an immutable context session ID");
          }
          await tx.contextSession.update({
            where: { id: contextSession.id },
            data: {
              runtimeSessionId: event.sessionId,
              runtimeSessionPath: event.sessionPath,
            },
          });
          if (contextSession.scope === "home") {
            if (bot.runtimeSessionPath && bot.runtimeSessionPath !== event.sessionPath) {
              throw new Error("Runtime attempted to replace the bot's immutable home Pi session");
            }
            if (bot.runtimeSessionId && bot.runtimeSessionId !== event.sessionId) {
              throw new Error(
                "Runtime attempted to replace the bot's immutable home Pi session ID"
              );
            }
            await tx.bot.update({
              where: { id: botId },
              data: {
                runtimeProvider: event.provider,
                runtimeSessionId: event.sessionId,
                runtimeSessionPath: event.sessionPath,
              },
            });
          }
          await tx.conversation.update({
            where: { id: conversationId },
            data: { continuity: "attached" },
          });
          await this.event(tx, "bot.session.attached", botId, event);
        });
        break;
      case "context.state":
        await this.prisma.$transaction(async (tx) => {
          const contextSession = await tx.contextSession.findUniqueOrThrow({
            where: { id: event.contextSessionId },
          });
          if (contextSession.botId !== botId) {
            throw new Error("Runtime reported another bot's context state");
          }
          if (
            event.epoch !== event.archives.length ||
            event.archives.some((archive, index) => archive.sequence !== index + 1)
          ) {
            throw new Error("Runtime reported a non-contiguous compaction manifest");
          }
          for (const archive of event.archives) {
            const existing = await tx.contextCompaction.findUnique({
              where: { id: archive.id },
              select: { contextSessionId: true, sequence: true },
            });
            if (
              existing &&
              (existing.contextSessionId !== contextSession.id ||
                existing.sequence !== archive.sequence)
            ) {
              throw new Error("Runtime reused a compaction ID for another archive");
            }
            await tx.contextCompaction.upsert({
              where: { id: archive.id },
              create: {
                id: archive.id,
                contextSessionId: contextSession.id,
                sequence: archive.sequence,
                reason: archive.reason,
                prefixDigest: archive.prefixDigest,
                summaryDigest: archive.summaryDigest,
                tokensBefore: archive.tokensBefore,
                tokensAfter: archive.tokensAfter,
                imageCount: archive.imageCount,
                turnCount: archive.turnCount,
                startedAt: new Date(archive.startedAt),
                completedAt: new Date(archive.completedAt),
              },
              update: {
                status: "adopted",
                reason: archive.reason,
                prefixDigest: archive.prefixDigest,
                summaryDigest: archive.summaryDigest,
                tokensBefore: archive.tokensBefore,
                tokensAfter: archive.tokensAfter,
                imageCount: archive.imageCount,
                turnCount: archive.turnCount,
                completedAt: new Date(archive.completedAt),
              },
            });
          }
          await tx.contextCompaction.updateMany({
            where: {
              contextSessionId: contextSession.id,
              sequence: { gt: event.epoch },
            },
            data: { status: "stale" },
          });
          await tx.contextSession.update({
            where: { id: contextSession.id },
            data: {
              compactionEpoch: event.epoch,
              lastArchiveId: event.archives.at(-1)?.id ?? null,
            },
          });
          if (contextSession.scope === "home") {
            await tx.conversation.update({
              where: { id: contextSession.scopeId },
              data: { compactionEpoch: event.epoch },
            });
          }
        });
        break;
      case "turn.started":
        await this.prisma.$transaction(async (tx) => {
          const started = await tx.run.updateMany({
            where: {
              id: runId,
              status: { in: ["queued", "running", "waiting_approval"] },
            },
            data: {
              runtimeTurnId: event.turnId,
              status: "running",
              startedAt: new Date(),
            },
          });
          if (started.count > 0) {
            await this.event(tx, "run.started", runId, {
              runId,
              turnId: event.turnId,
            });
          }
        });
        break;
      case "input.delivered":
        await this.prisma.$transaction(async (tx) => {
          const delivered = await tx.inboxEvent.updateMany({
            where: {
              id: event.inboxId,
              runId,
              deliveryMode: "steer",
              status: "processing",
            },
            data: {
              status: "completed",
              completedAt: new Date(),
            },
          });
          if (delivered.count > 0) {
            await this.event(tx, "input.steer_delivered", event.inboxId, {
              runId,
              inboxId: event.inboxId,
              clientMessageId: event.clientMessageId,
              turnId: event.turnId,
            });
          }
        });
        break;
      case "agent.delta":
        await this.prisma.$transaction(async (tx) => {
          const existing = await tx.message.findUnique({
            where: {
              conversationId_upstreamItemId: {
                conversationId,
                upstreamItemId: event.itemId,
              },
            },
          });
          if (existing?.status !== "completed") {
            if (existing) {
              await tx.message.update({
                where: { id: existing.id },
                data: {
                  content: `${existing.content}${event.delta}`,
                  status: "streaming",
                },
              });
            } else {
              await tx.message.create({
                data: {
                  botId,
                  conversationId,
                  runId,
                  upstreamItemId: event.itemId,
                  role: "assistant",
                  content: event.delta,
                  status: "streaming",
                },
              });
            }
          }
          await tx.runItem.upsert({
            where: {
              runId_upstreamItemId: { runId, upstreamItemId: event.itemId },
            },
            create: {
              runId,
              upstreamItemId: event.itemId,
              kind: "agent_message",
              status: "running",
              content: { text: event.delta },
              startedAt: new Date(),
            },
            update: { status: "running" },
          });
          await this.event(tx, "message.delta", runId, event);
        });
        break;
      case "item.started":
      case "item.completed": {
        const item = event.item as Record<string, unknown>;
        const upstreamItemId = String(item.id ?? crypto.randomUUID());
        const completed = event.type === "item.completed";
        await this.prisma.$transaction(async (tx) => {
          await tx.runItem.upsert({
            where: { runId_upstreamItemId: { runId, upstreamItemId } },
            create: {
              runId,
              upstreamItemId,
              kind: itemType(item),
              status: itemStatus(item, completed),
              title:
                typeof item.command === "string"
                  ? item.command.slice(0, 160)
                  : typeof item.tool === "string"
                    ? item.tool
                    : String(item.type ?? "Activity"),
              content: json(item),
              startedAt: new Date(),
              completedAt: completed ? new Date() : null,
            },
            update: {
              kind: itemType(item),
              status: itemStatus(item, completed),
              content: json(item),
              completedAt: completed ? new Date() : undefined,
            },
          });
          if (item.type === "agentMessage" && typeof item.text === "string") {
            await tx.message.upsert({
              where: {
                conversationId_upstreamItemId: {
                  conversationId,
                  upstreamItemId,
                },
              },
              create: {
                botId,
                conversationId,
                runId,
                upstreamItemId,
                role: "assistant",
                content: item.text,
                status: "completed",
              },
              update: { content: item.text, status: "completed" },
            });
          }
          await this.event(tx, completed ? "run_item.completed" : "run_item.started", runId, {
            runId,
            upstreamItemId,
            item,
          });
        });
        if (completed && item.type === "commandExecution" && typeof item.command === "string") {
          await this.agentData?.appendAudit(botId, {
            eventId: upstreamItemId,
            turnId: event.turnId,
            type: "shell_command",
            command: item.command,
            shellKind: typeof item.shellKind === "string" ? item.shellKind : "unknown",
            target: "computer",
          });
        }
        break;
      }
      case "approval.requested":
        await this.prisma.$transaction(async (tx) => {
          const runItem = await tx.runItem.findUnique({
            where: {
              runId_upstreamItemId: { runId, upstreamItemId: event.itemId },
            },
          });
          await tx.approval.upsert({
            where: { upstreamRequestId: event.approvalId },
            create: {
              runId,
              runItemId: runItem?.id,
              upstreamRequestId: event.approvalId,
              requestMethod: event.requestMethod,
              kind: event.requestMethod.includes("fileChange") ? "file_change" : "command",
              details: json(event.details),
            },
            update: {},
          });
          await tx.run.updateMany({
            where: {
              id: runId,
              status: { in: ["queued", "running", "waiting_approval"] },
            },
            data: { status: "waiting_approval" },
          });
          if (runItem) {
            await tx.runItem.update({
              where: { id: runItem.id },
              data: { status: "waiting_approval" },
            });
          }
          await this.event(tx, "approval.requested", runId, event);
        });
        break;
      case "compaction":
        await this.prisma.$transaction(async (tx) => {
          const contextSession = await tx.contextSession.findUniqueOrThrow({
            where: { id: event.contextSessionId },
          });
          if (contextSession.botId !== botId) {
            throw new Error("Runtime reported another bot's compaction");
          }
          const existing = await tx.contextCompaction.findUnique({
            where: { id: event.compactionId },
          });
          if (
            existing &&
            (existing.contextSessionId !== contextSession.id || existing.sequence !== event.epoch)
          ) {
            throw new Error("Runtime reused a compaction ID for another archive");
          }
          await tx.contextCompaction.upsert({
            where: { id: event.compactionId },
            create: {
              id: event.compactionId,
              contextSessionId: contextSession.id,
              sequence: event.epoch,
              reason: event.reason,
              prefixDigest: event.prefixDigest,
              summaryDigest: event.summaryDigest,
              tokensBefore: event.tokensBefore,
              tokensAfter: event.tokensAfter,
              imageCount: event.imageCount,
              turnCount: event.turnCount,
              startedAt: new Date(event.startedAt),
              completedAt: new Date(event.completedAt),
            },
            update: { status: "adopted", completedAt: new Date(event.completedAt) },
          });
          if (contextSession.compactionEpoch < event.epoch) {
            await tx.contextSession.update({
              where: { id: contextSession.id },
              data: { compactionEpoch: event.epoch, lastArchiveId: event.compactionId },
            });
            if (contextSession.scope === "home") {
              await tx.conversation.update({
                where: { id: contextSession.scopeId },
                data: { compactionEpoch: event.epoch },
              });
            }
          }
          if (!existing) await this.event(tx, "conversation.compacted", conversationId, event);
        });
        break;
      case "runtime.error":
        await this.prisma.$transaction(async (tx) => {
          await tx.runItem.create({
            data: {
              runId,
              kind: "error",
              status: event.retrying ? "running" : "failed",
              title: "Runtime error",
              content: json(event),
              completedAt: event.retrying ? null : new Date(),
            },
          });
          await this.event(tx, "runtime.error", runId, event);
        });
        break;
      case "turn.completed": {
        const status =
          event.status === "completed"
            ? "completed"
            : event.status === "interrupted"
              ? "interrupted"
              : event.status === "failed"
                ? "failed"
                : "interrupted";
        await this.prisma.$transaction(async (tx) => {
          const current = await tx.run.findUniqueOrThrow({
            where: { id: runId },
          });
          const finalStatus = current.status === "cancelled" ? "cancelled" : status;
          const finalItemStatus =
            finalStatus === "completed"
              ? "completed"
              : finalStatus === "cancelled"
                ? "cancelled"
                : "failed";
          await tx.run.update({
            where: { id: runId },
            data: {
              status: finalStatus,
              completedAt: new Date(),
              error: event.error ? json(event.error) : undefined,
            },
          });
          await tx.runItem.updateMany({
            where: {
              runId,
              status: { in: ["pending", "running", "waiting_approval"] },
            },
            data: { status: finalItemStatus, completedAt: new Date() },
          });
          await tx.message.updateMany({
            where: { runId, status: "streaming" },
            data: {
              status: finalStatus === "completed" ? "completed" : "failed",
            },
          });
          await tx.approval.updateMany({
            where: {
              runId,
              status: "pending",
              requestMethod: { not: "plugin/tool" },
            },
            data: { status: "expired", resolvedAt: new Date() },
          });
          await this.event(tx, "run.completed", runId, {
            ...event,
            runId,
            status: finalStatus,
          });
        });
        break;
      }
    }
  }

  private event(tx: Prisma.TransactionClient, topic: string, entityId: string, payload: unknown) {
    return tx.event.create({
      data: { topic, entityId, payload: json(payload) },
    });
  }
}
