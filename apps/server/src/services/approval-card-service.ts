import {
  ApiError,
  AUTO_REVIEW_APPROVAL_TTL_MS,
  AUTO_REVIEW_SURFACES,
  approvalCardPresentation,
  withSavedAllowRule,
  type ApprovalCard,
  type ApprovalCardState,
  type ApprovalRequest,
  type AutoReviewExpiryPolicy,
} from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, nextMessageAddress, publishMessageNotification } from "@openteam/messaging";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView } from "./view-mappers";

/** What the runtime reads while it holds a blocked action. */
export type ApprovalWait =
  | { status: "pending"; approvalId: string }
  | { status: "busy" }
  | { status: "approved" | "always" | "denied"; approvalId: string; savedRule?: string }
  | { status: "expired"; approvalId: string; retired: NonNullable<ApprovalCard["retired"]> };


/** The bound of one long-poll; Bun's idle timeout is 255 seconds and the runtime re-issues the wait. */
const WAIT_SLICE_MS = 20_000;
const POLL_MS = 250;
/** Turns where the user is in the conversation park their cards; the others expire them. */
const PARKING_ORIGINS = new Set(["user", "bootstrap", "handoff_resume"]);
const DECISIONS = new Set(["approved", "always", "denied"]);
const LIVE_RUN_STATUSES = new Set(["queued", "running"]);

type Tx = Prisma.TransactionClient;

export class ApprovalCardService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging
  ) {}

  /** The bot the user knows (a worker's top-level parent), the chat where its card goes, and the expiry policy. */
  private async owner(context: ToolContext) {
    let botId = context.botId;
    let channelId = context.channelId;
    let runId = context.runId;
    for (let depth = 0; depth < 8; depth++) {
      const parent = await this.prisma.subagent.findUnique({
        where: { childBotId: botId },
        select: { parentBotId: true, parentChannelId: true, parentRunId: true },
      });
      if (!parent) break;
      ({ parentBotId: botId, parentChannelId: channelId, parentRunId: runId } = parent);
    }
    const [bot, channel, run] = await Promise.all([
      this.prisma.bot.findUniqueOrThrow({ where: { id: botId }, select: { name: true } }),
      this.prisma.channel.findUnique({ where: { id: channelId }, select: { kind: true, archivedAt: true } }),
      this.prisma.run.findUnique({ where: { id: runId }, select: { origin: true } }),
    ]);
    // A room or a bot-to-bot chat cannot hold the card, so it goes to the bot's own 1:1 chat.
    const home =
      channel?.kind === "bot_dm" && !channel.archivedAt
        ? channelId
        : (
            await this.prisma.channel.findFirst({
              where: { kind: "bot_dm", archivedAt: null, members: { some: { botId } } },
              select: { id: true },
            })
          )?.id;
    if (!home) throw new ApiError(409, "approval_unavailable", "This bot has no chat where the user can approve the action");
    const expiryPolicy: AutoReviewExpiryPolicy = run && PARKING_ORIGINS.has(run.origin) ? "park" : "ttl";
    return { botId, botName: bot.name, channelId: home, expiryPolicy };
  }

  private pendingCards(tx: Tx | PrismaClient, botId: string) {
    return tx.channelMessage.findMany({
      where: {
        senderBotId: botId,
        AND: [{ metadata: { path: ["type"], equals: "approval" } }, { metadata: { path: ["cardState"], equals: "pending" } }],
      },
      orderBy: { sequence: "asc" },
      take: 20,
    });
  }

  /** Settles a pending card in place; returns null when it had already settled. */
  private async settle(tx: Tx, messageId: string, state: Exclude<ApprovalCardState, "pending">, extra: Partial<ApprovalCard> = {}) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
    const message = await tx.channelMessage.findUnique({ where: { id: messageId } });
    const metadata = metadataRecord(message?.metadata);
    if (!message || metadata.type !== "approval" || metadata.cardState !== "pending") return null;
    const updated = await tx.channelMessage.update({
      where: { id: messageId },
      data: { metadata: toJson({ ...metadata, ...extra, cardState: state, resolvedAt: new Date().toISOString() }) },
    });
    await appendEvent(tx, "channel.message.updated", messageId, { channelId: message.channelId, messageId });
    if (message.senderBotId) await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId]);
    return updated;
  }

  private expired(metadata: Record<string, unknown>, now = Date.now()) {
    return typeof metadata.expiresAt === "string" && Date.parse(metadata.expiresAt) <= now;
  }

  private waitResult(messageId: string, metadata: Record<string, unknown>): ApprovalWait {
    const state = String(metadata.cardState);
    if (state === "pending") return { status: "pending", approvalId: messageId };
    if (state === "expired")
      return { status: "expired", approvalId: messageId, retired: (metadata.retired as "ttl" | "cancelled") ?? "ttl" };
    return {
      status: state as "approved" | "always" | "denied",
      approvalId: messageId,
      ...(typeof metadata.savedRule === "string" ? { savedRule: metadata.savedRule } : {}),
    };
  }

  /** Raises the card for a blocked action, unless another of this bot's cards still waits on the user. */
  async request(context: ToolContext, raw: unknown): Promise<ApprovalWait> {
    const input = metadataRecord(raw) as unknown as ApprovalRequest;
    if (!AUTO_REVIEW_SURFACES.includes(input.surface) || typeof input.reason !== "string" || typeof input.summary !== "string" || typeof input.fingerprint !== "string")
      throw new ApiError(400, "approval_invalid", "An approval needs a surface, summary, reason and fingerprint");
    const owner = await this.owner(context);
    const clientId = `approval:${context.runId}:${context.callId}`;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`approval:${owner.botId}`}))`;
      const replay = await tx.channelMessage.findUnique({ where: { channelId_clientId: { channelId: owner.channelId, clientId } } });
      if (replay) return this.waitResult(replay.id, metadataRecord(replay.metadata));
      for (const pending of await this.pendingCards(tx, owner.botId)) {
        const retired = await this.staleState(tx, metadataRecord(pending.metadata));
        if (!retired) return { status: "busy" } as const;
        await this.settle(tx, pending.id, "expired", { retired });
      }
      const request: ApprovalRequest = {
        surface: input.surface,
        fingerprint: input.fingerprint,
        summary: input.summary.slice(0, 500),
        reason: input.reason.slice(0, 2_000),
        ...(input.summaryCopy ? { summaryCopy: input.summaryCopy } : {}),
        ...(input.actionDescription ? { actionDescription: String(input.actionDescription).slice(0, 500) } : {}),
        ...(input.command ? { command: String(input.command).slice(0, 4_000) } : {}),
        ...(input.fullRequest ? { fullRequest: String(input.fullRequest).slice(0, 12_000) } : {}),
        ...(input.proposedRule ? { proposedRule: String(input.proposedRule).slice(0, 1_000) } : {}),
        ...(input.proposedRule && input.proposedRuleReplaces ? { proposedRuleReplaces: String(input.proposedRuleReplaces) } : {}),
        ...(input.cautionNote ? { cautionNote: input.cautionNote } : {}),
        ...(Array.isArray(input.appliedRules) && input.appliedRules.length ? { appliedRules: input.appliedRules } : {}),
        expiryPolicy: owner.expiryPolicy,
      };
      const presentation = approvalCardPresentation(request, owner.botName);
      const card: ApprovalCard = {
        type: "approval",
        ...request,
        presentation,
        cardState: "pending",
        expiresAt: owner.expiryPolicy === "ttl" ? new Date(Date.now() + AUTO_REVIEW_APPROVAL_TTL_MS).toISOString() : null,
      };
      const address = await nextMessageAddress(tx, owner.channelId, "agent");
      const message = await tx.channelMessage.create({
        data: {
          channelId: owner.channelId,
          sender: "agent",
          senderBotId: owner.botId,
          sourceRunId: context.runId,
          clientId,
          content: presentation.title,
          metadata: toJson({ kind: "send-message", ...card, address, requestRunId: context.runId, requestBotId: context.botId }),
        },
      });
      await publishMessageNotification(tx, message);
      await this.messaging.scheduleTranscriptProjection(tx, [owner.botId]);
      await tx.channel.update({ where: { id: owner.channelId }, data: { updatedAt: new Date() } });
      return { status: "pending", approvalId: message.id } as const;
    });
  }

  /** Waits a slice for the user's answer; a card whose run stopped or whose time ran out expires. */
  async wait(context: ToolContext, raw: unknown, signal?: AbortSignal): Promise<ApprovalWait> {
    const approvalId = String(metadataRecord(raw).approvalId ?? "");
    const deadline = Date.now() + WAIT_SLICE_MS;
    for (;;) {
      const message = await this.prisma.channelMessage.findUnique({ where: { id: approvalId } });
      const metadata = metadataRecord(message?.metadata);
      if (!message || metadata.type !== "approval" || metadata.requestRunId !== context.runId)
        throw new ApiError(404, "approval_not_found", "Approval card not found");
      if (metadata.cardState !== "pending") return this.waitResult(message.id, metadata);
      if (this.expired(metadata)) {
        await this.prisma.$transaction((tx) => this.settle(tx, message.id, "expired", { retired: "ttl" }));
        continue;
      }
      if (Date.now() >= deadline || signal?.aborted) return { status: "pending", approvalId: message.id };
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /** The runtime stopped waiting (its turn ended or was interrupted): the card can no longer run anything. */
  async cancel(context: ToolContext, raw: unknown) {
    const approvalId = String(metadataRecord(raw).approvalId ?? "");
    const message = await this.prisma.channelMessage.findUnique({ where: { id: approvalId } });
    if (!message || metadataRecord(message.metadata).requestRunId !== context.runId) return { cancelled: false };
    const settled = await this.prisma.$transaction((tx) => this.settle(tx, approvalId, "expired", { retired: "cancelled" }));
    return { cancelled: settled !== null };
  }

  /** The user's answer on the card. "Always allow" also saves the card's proposed Allow rule. */
  answer = (messageId: string, raw: unknown) =>
    serviceEffect(async () => {
      const decision = String(metadataRecord(raw).decision);
      if (!DECISIONS.has(decision)) throw new ApiError(400, "approval_decision_invalid", "Choose approved, always or denied");
      const message = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
        const current = await tx.channelMessage.findUnique({ where: { id: messageId }, include: { channel: true } });
        const metadata = metadataRecord(current?.metadata);
        if (!current || current.channel.archivedAt || metadata.type !== "approval")
          throw new ApiError(404, "approval_not_found", "Approval card not found");
        if (metadata.cardState !== "pending") return current;
        const retired = await this.staleState(tx, metadata);
        if (retired) return (await this.settle(tx, messageId, "expired", { retired })) ?? current;
        let savedRule: string | undefined;
        if (decision === "always" && typeof metadata.proposedRule === "string") {
          const settings = await tx.autoReviewSettings.findUnique({ where: { id: "global" } });
          const allowRules = withSavedAllowRule(
            settings?.allowRules ?? [],
            metadata.proposedRule,
            typeof metadata.proposedRuleReplaces === "string" ? metadata.proposedRuleReplaces : undefined
          );
          if (!allowRules)
            throw new ApiError(409, "allow_rules_full", "Couldn't save. You already have 20 Allow rules; remove one in Settings and try again.");
          await tx.autoReviewSettings.upsert({
            where: { id: "global" },
            create: { id: "global", allowRules },
            update: { allowRules },
          });
          savedRule = metadata.proposedRule;
        }
        const state = decision === "always" && savedRule === undefined ? "approved" : (decision as "approved" | "always" | "denied");
        return (await this.settle(tx, messageId, state, savedRule === undefined ? {} : { savedRule })) ?? current;
      });
      return { accepted: true, message: toChannelMessageView(message), runId: null };
    });

  /** A card nobody can act on any more expires: its time ran out, or the run holding the action ended. */
  private async staleState(tx: Tx | PrismaClient, metadata: Record<string, unknown>) {
    if (this.expired(metadata)) return "ttl" as const;
    const run = typeof metadata.requestRunId === "string"
      ? await tx.run.findUnique({ where: { id: metadata.requestRunId }, select: { status: true } })
      : null;
    return run && LIVE_RUN_STATUSES.has(run.status) ? null : ("cancelled" as const);
  }

  /** Periodic sweep, so a card whose run stopped (a restart, a crash) does not hold the next one. */
  async sweep() {
    const pending = await this.prisma.channelMessage.findMany({
      where: { AND: [{ metadata: { path: ["type"], equals: "approval" } }, { metadata: { path: ["cardState"], equals: "pending" } }] },
      take: 200,
    });
    for (const message of pending) {
      const retired = await this.staleState(this.prisma, metadataRecord(message.metadata));
      if (retired) await this.prisma.$transaction((tx) => this.settle(tx, message.id, "expired", { retired }));
    }
  }
}
