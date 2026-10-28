import { createHash } from "node:crypto";
import { ApiError, messagesSendRecipient, validateMessageSend, type MessagesSend } from "@openteam/contracts";
import { type PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, PRIORITY } from "@openteam/messaging";
import type { MachineService } from "./machine-service";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView } from "./view-mappers";

// A discarded or unconfirmed card does not wake the bot; it reads the outcome on its next turn.
const DISCARDED_OUTCOME =
  "The user discarded your text without sending it. They refused to send it. Do not send it another way. Treat it as rejected; only send it again if the user explicitly asks.";
const UNCONFIRMED_OUTCOME =
  "The send started on the Mac, but its outcome is unknown: it may or may not have gone out. Check the chat with ChatItems before discussing another attempt, and never send it again automatically.";

interface StoredSend extends MessagesSend {
  machineId: string;
  machineLabel: string;
  recipientLabel: string;
  allowable: boolean;
  runId: string;
}

const fail = (message: string): never => {
  throw new ApiError(409, "imessage_send_unavailable", message);
};
const describe = (send: StoredSend) =>
  `From: ${send.machineLabel}\nTo: ${send.recipientLabel}${send.to && send.recipientName ? ` (${send.to})` : ""}${send.chatId ? ` (${send.chatId})` : ""}\n\n${send.text}`;
const fields = ({ text, to, chatId, service, recipientName }: StoredSend): MessagesSend => ({
  text, ...(to ? { to } : {}), ...(chatId ? { chatId } : {}), ...(service ? { service } : {}), ...(recipientName ? { recipientName } : {}),
});

/** SendIMessage raises a card on the user's chat; Send runs it on the chosen Mac, once. */
export class MessagesSendService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly machines: Pick<MachineService, "messagesMachine" | "messagesSendAllowed" | "allowMessagesRecipient" | "callCapability" | "relay">
  ) {}

  async create(context: ToolContext, raw: unknown): Promise<Record<string, unknown> | string> {
    const { machineId: requested, ...input } = metadataRecord(raw);
    let send: MessagesSend;
    try { send = validateMessageSend(input); }
    catch (error) { throw new ApiError(400, "imessage_send_invalid", error instanceof Error ? error.message : String(error)); }
    const machine = await this.machines.messagesMachine(context.botId, context.channelId, typeof requested === "string" ? requested : undefined);
    const recipient = messagesSendRecipient(send);
    const allowed = await this.machines.messagesSendAllowed(machine.machineId, recipient.allowable ? send.to : undefined);
    const room = (await this.prisma.channel.findUnique({ where: { id: context.channelId }, select: { kind: true } }))?.kind === "group";
    const stored: StoredSend = { ...send, machineId: machine.machineId, machineLabel: machine.label, recipientLabel: recipient.label, allowable: recipient.allowable, runId: context.runId };
    const result = await this.messaging.sendVisible(context, {
      type: "imessage-send",
      imessage: stored,
      end_turn: false,
      ...(room ? { to: "dm" } : {}),
      ...(allowed ? { cardState: "sending", sendStartedAt: new Date().toISOString(), sentUnder: true } : {}),
    } as Parameters<AgentMessaging["sendVisible"]>[1]);
    const acknowledgement: Record<string, unknown> = typeof result.acknowledgement === "string"
      ? { note: result.acknowledgement }
      : { ...(result.acknowledgement as Record<string, unknown>), machine: machine.label, ...(room ? { in_dm: true } : {}) };
    if (!allowed || acknowledgement.duplicate) return { ...acknowledgement, delivery: allowed ? "sending" : "awaiting_approval" };
    const delivered = await this.deliver(String(acknowledgement.message_id), false);
    const metadata = metadataRecord(delivered.message.metadata);
    return { ...acknowledgement, delivery: metadata.cardState, ...(metadata.sendResult ? { result: metadata.sendResult } : {}), ...(metadata.sendError ? { error: metadata.sendError } : {}) };
  }

  mutate = (messageId: string, raw: unknown) =>
    serviceEffect(async () => {
      const input = metadataRecord(raw);
      if (!["send", "cancel", "allow", "refresh"].includes(String(input.action))) return fail("Choose send, allow, cancel or refresh");
      const claim = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
        const message = await tx.channelMessage.findUnique({ where: { id: messageId }, include: { channel: true } });
        const metadata = metadataRecord(message?.metadata);
        if (!message?.senderBotId || message.channel.archivedAt || metadata.type !== "imessage-send") return fail("Text approval card not found");
        if (input.action === "refresh" || (metadata.cardState && metadata.cardState !== "pending")) return { message, claimed: false };
        const stored = metadataRecord(metadata.imessage) as unknown as StoredSend;
        if (input.action === "allow") {
          if (!stored.allowable || !stored.to) return fail("Only a text to one recipient can be allowed");
          await this.machines.allowMessagesRecipient(stored.machineId, stored.to, stored.recipientName);
        }
        const state = input.action === "cancel" ? "dismissed" : "sending";
        const { sendError: _error, ...rest } = metadata;
        const updated = await tx.channelMessage.update({
          where: { id: messageId },
          data: { metadata: toJson({ ...rest, cardState: state, ...(state === "sending" ? { sendStartedAt: new Date().toISOString() } : {}), ...(input.action === "allow" ? { allowedRecipient: stored.to } : {}) }) },
        });
        await appendEvent(tx, "channel.message.updated", messageId, { channelId: message.channelId, messageId });
        return { message: updated, claimed: state === "sending" };
      });
      const metadata = metadataRecord(claim.message.metadata);
      if (metadata.cardState === "dismissed" && !metadata.outcomeId) return this.settle(messageId, "dismissed", DISCARDED_OUTCOME, false, false);
      if (!claim.claimed) {
        if (metadata.cardState === "sending" && Date.now() - Date.parse(String(metadata.sendStartedAt)) > 180_000)
          return this.settle(messageId, "unknown", UNCONFIRMED_OUTCOME, false, false);
        return { accepted: false, message: toChannelMessageView(claim.message), runId: null };
      }
      return this.deliver(messageId);
    });

  /** Sends a card already in the sending state. Nothing reached the Mac: the card stays open with the reason. */
  private async deliver(messageId: string, wake = true) {
    const message = await this.prisma.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
    const metadata = metadataRecord(message.metadata);
    const stored = metadataRecord(metadata.imessage) as unknown as StoredSend;
    if (!this.machines.relay.connected(stored.machineId))
      return this.reopen(messageId, `${stored.machineLabel} is offline. Open OpenTeam on that Mac, then press Send again.`);
    let result: Record<string, unknown>;
    try {
      // The Mac keeps a receipt per call ID, so pressing Send again never texts twice.
      result = await this.machines.callCapability(stored.machineId, { tool: "SendIMessage", botId: message.senderBotId, callId: `imessage-send:${messageId}`, arguments: fields(stored) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/outcome is uncertain|disconnected|already dispatched/i.test(reason)) return this.settle(messageId, "unknown", UNCONFIRMED_OUTCOME, false, !wake);
      return this.settle(messageId, "failed", `Nothing was sent: ${stored.machineLabel} refused the text (${reason}).`, wake, !wake, { sendError: reason.slice(0, 500) });
    }
    const how = metadata.sentUnder
      ? "Sent without an approval card: the user allowed this recipient, or every send, on that Mac."
      : metadata.allowedRecipient ? `The user sent it and allowed ${String(metadata.allowedRecipient)} from now on.` : "The user approved and sent your text.";
    const seen = result.verified === true ? "It already appears in the Messages chat." : "It has not appeared in the Messages chat yet; that is not a failure, so do not resend it.";
    return this.settle(messageId, "sent", `${how} ${seen}`, wake, !wake, { sendResult: result });
  }

  private reopen(messageId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const { sendStartedAt: _started, sentUnder: _sentUnder, ...metadata } = metadataRecord(message.metadata);
      const updated = await tx.channelMessage.update({ where: { id: messageId }, data: { metadata: toJson({ ...metadata, cardState: "pending", sendError: reason.slice(0, 500) }) } });
      await appendEvent(tx, "channel.message.updated", messageId, { channelId: message.channelId, messageId });
      return { accepted: false, message: toChannelMessageView(updated), runId: null };
    });
  }

  /** wake: start a turn for the outcome now. echoed: the outcome was already reported in the tool result. */
  private async settle(messageId: string, state: string, outcome: string, wake = true, echoed = !wake, extra: Record<string, unknown> = {}) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const metadata = metadataRecord(message.metadata);
      if (metadata.outcomeId) return { accepted: false, message: toChannelMessageView(message), runId: null };
      const outcomeId = createHash("sha256").update(`${messageId}:${state}`).digest("hex");
      const stored = metadataRecord(metadata.imessage) as unknown as StoredSend;
      const updated = await tx.channelMessage.update({
        where: { id: messageId },
        data: { metadata: toJson({ ...metadata, ...extra, cardState: state, outcomeId, outcomeText: `${outcome}\n\n${describe(stored)}`.slice(0, 10000), outcomeEchoed: echoed }) },
      });
      const wakeRun = wake
        ? await this.messaging.enqueueWake(tx, {
            botId: message.senderBotId!,
            channelId: message.channelId,
            origin: "user",
            type: "imessage.response",
            content: "[SAND_HIDDEN_PROMPT]A text you asked to send settled. Read its outcome context and continue.",
            clientId: `imessage-send:${messageId}:outcome`,
            priority: PRIORITY.user,
            wrapUserContent: false,
          })
        : null;
      await appendEvent(tx, "channel.message.updated", messageId, { channelId: message.channelId, messageId });
      await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId!]);
      return { accepted: true, message: toChannelMessageView(updated), runId: wakeRun?.run.id ?? null };
    });
  }
}
