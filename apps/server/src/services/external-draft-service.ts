import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  externalDraftHtml,
  editExternalDraft,
  parseExternalDraft,
  type ExternalDraft,
} from "@openteam/contracts";
import { type PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, PRIORITY } from "@openteam/messaging";
import type { PluginService } from "./plugin-service";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView } from "./view-mappers";

const fail = (message: string): never => {
  throw new ApiError(409, "draft_unavailable", message);
};
function connectorRecord(raw: unknown): Record<string, any> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== raw) return connectorRecord(parsed);
    } catch {
      /* Some connectors return the created ID directly. */
    }
    if (/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return { id: raw };
  }
  if (!raw || typeof raw !== "object") return fail("The connector returned an unreadable result");
  const result = raw as Record<string, any>;
  if (result.isError || result.error || result.ok === false)
    return fail("The connector did not complete the operation");
  if (result.structuredContent) return connectorRecord(result.structuredContent);
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n");
    try {
      return connectorRecord(JSON.parse(text));
    } catch {
      return fail("The connector returned an unreadable result");
    }
  }
  return result;
}
function sentAddress(result: Record<string, any>) {
  for (const thread of result.threads ?? [])
    for (const message of thread.messages ?? []) {
      if (!message.labelIds?.includes("SENT") || typeof message.sender !== "string") continue;
      return (/<([^<>\s]+@[^<>\s]+)>/.exec(message.sender)?.[1] ?? message.sender)
        .trim()
        .toLowerCase();
    }
  return fail("The mailbox needs a sent message to verify the sending address");
}
export class ExternalDraftService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly plugins: Pick<PluginService, "invoke" | "invokeReviewed">
  ) {}
  private async verify(botId: string, runId: string, draft: ExternalDraft, prefix: string) {
    const read = async (toolName: string, args: unknown) =>
      connectorRecord(
        await this.plugins.invoke({
          connectionId: draft.providerIdentifier,
          botId,
          runId,
          callId: `${prefix}:${toolName}`,
          toolName,
          arguments: args,
        })
      );
    if (draft.platform === "email") {
      const from = sentAddress(await read("search_threads", { query: "in:sent", pageSize: 1 }));
      if (from !== draft.from!.toLowerCase())
        return fail("The selected mailbox does not match the draft From address");
      let thread: string | undefined;
      if (draft.replyToMessageId) {
        const message = await read("get_message", {
          messageId: draft.replyToMessageId,
          messageFormat: "MINIMAL",
        });
        if (typeof message.subject !== "string" || !message.subject)
          return fail("The reply message could not be verified");
        thread = message.subject.slice(0, 300);
      }
      return { identity: from, destination: draft.to!.join(", "), thread };
    }
    const channel = await read("slack_read_channel", {
      channel_id: draft.channelId,
      limit: 1,
      response_format: "concise",
    });
    const header =
      typeof channel.messages === "string" &&
      /^Channel:\s*(.+?)\s*\(([^)]+)\)/.exec(channel.messages);
    if (!header || header[2] !== draft.channelId)
      return fail("The Slack destination could not be verified");
    const account = await read("slack_read_user_profile", {});
    const profile = typeof account.result === "string" ? account.result : "";
    const workspace = /^Organization Name:\s*(.+)$/m.exec(profile)?.[1]?.trim();
    const email = /^Email:\s*(\S+@\S+)$/m.exec(profile)?.[1];
    if (!workspace || !email)
      return fail("The Slack workspace and sending account could not be verified");
    let thread: string | undefined;
    if (draft.threadTs) {
      const parent = await read("slack_read_thread", {
        channel_id: draft.channelId,
        message_ts: draft.threadTs,
        limit: 1,
        response_format: "detailed",
      });
      if (
        typeof parent.messages !== "string" ||
        !parent.messages.includes(`Message TS: ${draft.threadTs}`)
      )
        return fail("The Slack thread could not be verified");
      thread = parent.messages.slice(0, 500);
    }
    return { identity: `${workspace} (${email})`, destination: header[1]!, thread };
  }
  async create(context: ToolContext, raw: unknown) {
    const draft = parseExternalDraft(raw);
    const verification = await this.verify(
      context.botId,
      context.runId,
      draft,
      `draft-verify:${context.callId}`
    );
    if (draft.platform === "slack") draft.target = verification.destination;
    const result = await this.messaging.sendVisible(context, {
      type: "external-draft",
      draft: { ...draft, verification, runId: context.runId },
      end_turn: false,
    });
    return result.acknowledgement;
  }
  mutate = (messageId: string, raw: unknown) =>
    serviceEffect(async () => {
      const input = metadataRecord(raw);
      if (!["save", "send", "cancel", "refresh"].includes(String(input.action)))
        return fail("Choose save, send, cancel or refresh");
      const claim = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
        const message = await tx.channelMessage.findUnique({
          where: { id: messageId },
          include: { channel: true },
        });
        const metadata = metadataRecord(message?.metadata);
        if (
          !message?.senderBotId ||
          message.channel.archivedAt ||
          metadata.type !== "external-draft"
        )
          return fail("Draft card not found");
        if (metadata.cardState && metadata.cardState !== "pending")
          return { message, claimed: false };
        const stored = metadataRecord(metadata.draft);
        const draft =
          input.edits === undefined
            ? parseExternalDraft(stored)
            : editExternalDraft(parseExternalDraft(stored), input.edits);
        if (input.action === "refresh") return { message, claimed: false };
        const state =
          input.action === "send" ? "sending" : input.action === "cancel" ? "dismissed" : "pending";
        const updated = await tx.channelMessage.update({
          where: { id: messageId },
          data: {
            metadata: toJson({
              ...metadata,
              draft: { ...stored, ...draft },
              cardState: state,
              ...(state === "sending" ? { sendStartedAt: new Date().toISOString() } : {}),
            }),
          },
        });
        await appendEvent(tx, "channel.message.updated", messageId, {
          channelId: message.channelId,
          messageId,
        });
        return { message: updated, claimed: input.action === "send" };
      });
      const metadata = metadataRecord(claim.message.metadata);
      if (metadata.cardState === "dismissed" && !metadata.outcomeId)
        return this.settle(
          messageId,
          "dismissed",
          "The user cancelled the draft. Nothing was sent."
        );
      if (!claim.claimed) {
        if (metadata.cardState === "sending") {
          const call = await this.prisma.pluginInvocation.findUnique({
            where: { callId: `draft-send:${messageId}:send` },
          });
          if (call?.status === "completed") {
            try {
              connectorRecord(call.result);
              return this.settle(messageId, "sent", "The reviewed message was sent.");
            } catch {
              return this.settle(messageId, "failed", "The connector reported a send failure.");
            }
          }
          if (Date.now() - Date.parse(String(metadata.sendStartedAt)) > 180_000)
            return this.settle(
              messageId,
              "unknown",
              "Delivery was interrupted. Check the mailbox or Slack before creating another draft; this send will not be repeated automatically."
            );
        }
        return { accepted: false, message: toChannelMessageView(claim.message), runId: null };
      }
      const stored = metadataRecord(metadata.draft);
      const draft = parseExternalDraft(stored);
      const botId = claim.message.senderBotId!;
      const runId = String(stored.runId);
      let enteredSend = false;
      let staged = false;
      try {
        const verified = await this.verify(
          botId,
          runId,
          draft,
          `draft-send-verify:${messageId}:${randomUUID()}`
        );
        if (verified.identity !== metadataRecord(stored.verification).identity)
          return this.settle(
            messageId,
            "failed",
            "The connector account changed. Nothing was sent; create a new draft for the intended account."
          );
        const invoke = async (suffix: string, toolName: string, args: unknown) =>
          connectorRecord(
            await this.plugins.invokeReviewed({
              connectionId: draft.providerIdentifier,
              botId,
              runId,
              callId: `draft-send:${messageId}:${suffix}`,
              toolName,
              arguments: args,
            })
          );
        const emailArgs = {
          to: draft.to,
          ...(draft.cc?.length ? { cc: draft.cc } : {}),
          subject: draft.subject,
          body: draft.body,
          htmlBody: externalDraftHtml(draft.body),
        };
        if (draft.platform === "slack") {
          enteredSend = true;
          await invoke("send", "slack_send_message", {
            channel_id: draft.channelId,
            message: draft.body,
            ...(draft.threadTs ? { thread_ts: draft.threadTs } : {}),
          });
        } else if (draft.replyToMessageId) {
          const result = await invoke("stage", "create_draft", {
            ...emailArgs,
            replyToMessageId: draft.replyToMessageId,
          });
          if (typeof result.id !== "string" || !result.id)
            return fail("The mailbox did not return a draft ID");
          staged = true;
          enteredSend = true;
          await invoke("send", "send_message", { draftId: result.id });
        } else {
          enteredSend = true;
          await invoke("send", "send_message", emailArgs);
        }
        return this.settle(messageId, "sent", "The reviewed message was sent.");
      } catch {
        return this.settle(
          messageId,
          enteredSend ? "unknown" : staged ? "draft-created" : "failed",
          enteredSend
            ? "The send did not return a confirmed result. Check the destination before retrying; no automatic resend will occur."
            : staged
              ? "A reply draft was created in the mailbox, but was not sent."
              : "Draft verification or preparation failed. No message was sent."
        );
      }
    });
  private async settle(messageId: string, state: string, outcome: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const metadata = metadataRecord(message.metadata);
      if (metadata.outcomeId)
        return { accepted: false, message: toChannelMessageView(message), runId: null };
      const outcomeId = createHash("sha256").update(`${messageId}:${state}`).digest("hex");
      const updated = await tx.channelMessage.update({
        where: { id: messageId },
        data: {
          metadata: toJson({
            ...metadata,
            cardState: state,
            outcomeId,
            outcomeText: `${outcome}\nReviewed content: ${JSON.stringify(parseExternalDraft(metadata.draft)).slice(0, 10000)}`,
            outcomeEchoed: false,
          }),
        },
      });
      const wake = await this.messaging.enqueueWake(tx, {
        botId: message.senderBotId!,
        channelId: message.channelId,
        origin: "user",
        type: "draft.response",
        content:
          "[SAND_HIDDEN_PROMPT]An external message draft settled. Read its outcome context and continue.",
        clientId: `draft:${messageId}:outcome`,
        priority: PRIORITY.user,
        wrapUserContent: false,
      });
      await appendEvent(tx, "channel.message.updated", messageId, {
        channelId: message.channelId,
        messageId,
      });
      await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId!]);
      return { accepted: true, message: toChannelMessageView(updated), runId: wake.run.id };
    });
  }
}
