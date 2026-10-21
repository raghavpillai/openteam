import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  externalDraftAllowList,
  externalDraftApprovalMode,
  externalDraftHtml,
  externalDraftRecipients,
  editExternalDraft,
  parseExternalDraft,
  type ExternalDraft,
  type ExternalDraftApprovalMode,
  type ExternalDraftVerification,
} from "@openteam/contracts";
import { type PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, PRIORITY } from "@openteam/messaging";
import { connectionNamespace } from "@openteam/plugin-sdk";
import type { PluginService } from "./plugin-service";
import { definitionFromManifest } from "./plugin/values";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView } from "./view-mappers";

// A discarded or unconfirmed card does not wake the bot; it reads the outcome on its next turn.
const DISCARDED_DRAFT_OUTCOME =
  "The user discarded your draft without sending. They refused to send it. Do not send that message yourself (including via CallDynamicTool or any connector send tool). Treat the draft as rejected; only draft or send again if the user explicitly asks.";
const UNCONFIRMED_DRAFT_OUTCOME =
  "A send of your draft did not confirm. It may or may not have gone out. Do not send that message yourself (including via CallDynamicTool or any connector send tool). Check the destination before drafting or sending it again.";

const fail = (message: string): never => {
  throw new ApiError(409, "draft_unavailable", message);
};
/** The connector could not confirm where a draft goes; create() words it as the reference's refusal. */
const unverified = (reason: string): never => {
  throw new ApiError(409, "draft_route_unverified", reason);
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The fields a connector's reviewed-send tool receives. */
const emailFields = (draft: ExternalDraft) => ({
  from: draft.from,
  to: draft.to,
  ...(draft.cc?.length ? { cc: draft.cc } : {}),
  subject: draft.subject,
  body: draft.body,
  ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
});
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
/** What went out (or was about to), as the Bot reads it when it resumes. */
function describeDraft(draft: ExternalDraft, verification: Partial<ExternalDraftVerification>) {
  const lines =
    draft.platform === "email"
      ? [
          `From: ${draft.from}`,
          `To: ${draft.to!.join(", ")}`,
          ...(draft.cc?.length ? [`Cc: ${draft.cc.join(", ")}`] : []),
          `Subject: ${draft.subject}`,
          ...(draft.replyToMessageId
            ? [`In reply to: ${verification.thread ?? draft.replyToMessageId} (${draft.replyToMessageId})`]
            : []),
        ]
      : [
          `Workspace: ${verification.identity ?? ""}`,
          `To: ${draft.target} (${draft.channelId})`,
          ...(draft.threadTs ? [`In thread: ${verification.thread ?? draft.threadTs}`] : []),
        ];
  return `${lines.join("\n")}\n\n${draft.body}`;
}
export class ExternalDraftService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly plugins: Pick<PluginService, "invoke">
  ) {}
  /**
   * The connection behind a draft's providerIdentifier: its UUID, or the namespace
   * (`plugin_<uuid>`) GetMcpServerStatus lists. Includes the declared reviewed-send tool, if any.
   */
  private async connection(draft: ExternalDraft) {
    const identifier = draft.providerIdentifier;
    const parts = /^plugin_([0-9a-f]{8})_([0-9a-f]{4})_([0-9a-f]{4})_([0-9a-f]{4})_([0-9a-f]{12})(?:__[0-9a-f]+)?$/i.exec(identifier);
    const id = UUID.test(identifier) ? identifier : parts ? parts.slice(1).join("-") : undefined;
    const connection = id
      ? await this.prisma.pluginConnection.findUnique({
          where: { id },
          select: { id: true, alias: true, connectorKey: true, installation: { select: { manifest: true } } },
        })
      : null;
    if (!connection) return undefined;
    if (parts && connectionNamespace(connection.id, connection.alias) !== identifier)
      return fail("This account was renamed. Re-run GetMcpServerStatus and draft again.");
    const drafts = definitionFromManifest(connection.installation.manifest)?.connections.find(
      (connector) => connector.key === connection.connectorKey
    )?.drafts;
    return { id: connection.id, sendTool: drafts?.platform === draft.platform ? drafts.tool : undefined };
  }
  private async verify(
    botId: string,
    runId: string,
    draft: ExternalDraft,
    prefix: string
  ): Promise<ExternalDraftVerification> {
    const connection = await this.connection(draft);
    if (draft.platform === "email") {
      const sendTool = connection?.sendTool;
      if (!connection || !sendTool)
        return fail(
          "This connection can't send reviewed email. Use a connected Gmail or Email plugin account."
        );
      const result = connectorRecord(
        await this.plugins.invoke({
          connectionId: connection.id,
          botId,
          runId,
          callId: `${prefix}:${sendTool}`,
          toolName: sendTool,
          arguments: { action: "verify", draft: emailFields(draft) },
          hostTool: true,
        })
      );
      const identity = typeof result.identity === "string" ? result.identity.trim().toLowerCase() : "";
      const sendingAddresses = [
        ...new Set([identity, ...strings(result.sendingAddresses).map((address) => address.trim().toLowerCase())]),
      ].filter(Boolean);
      if (!identity) return unverified("The mailbox did not report its sending address.");
      if (!sendingAddresses.includes(draft.from!.toLowerCase()))
        return fail(`Draft refused: from (${draft.from}) is not the address this account really sends as (${sendingAddresses.join(", ")}). Nothing was drafted. Call this tool again with from: ${identity}${sendingAddresses.length > 1 ? " or one of the other addresses listed." : "."}`);
      const signatures = Object.fromEntries(
        Object.entries(metadataRecord(result.signatures))
          .map(([address, html]) => [address.toLowerCase(), html] as const)
          .filter(
            (entry): entry is readonly [string, string] =>
              sendingAddresses.includes(entry[0]) && typeof entry[1] === "string" && !!entry[1].trim()
          )
          .map(([address, html]) => [address, html.slice(0, 20_000)])
      );
      const threadUrl =
        typeof result.threadUrl === "string" && /^https:\/\//.test(result.threadUrl)
          ? result.threadUrl.slice(0, 2000)
          : undefined;
      return {
        identity,
        destination: draft.to!.join(", "),
        sendingAddresses,
        ...(Object.keys(signatures).length ? { signatures } : {}),
        ...(typeof result.thread === "string" ? { thread: result.thread.slice(0, 300) } : {}),
        ...(threadUrl ? { threadUrl } : {}),
      };
    }
    if (!connection) return fail("The Slack account was not found. Re-run GetMcpServerStatus and draft again.");
    const read = async (toolName: string, args: unknown) =>
      connectorRecord(
        await this.plugins.invoke({
          connectionId: connection.id,
          botId,
          runId,
          callId: `${prefix}:${toolName}`,
          toolName,
          arguments: args,
        })
      );
    const channel = await read("slack_read_channel", {
      channel_id: draft.channelId,
      limit: 1,
      response_format: "concise",
    });
    const header =
      typeof channel.messages === "string" &&
      /^Channel:\s*(.+?)\s*\(([^)]+)\)/.exec(channel.messages);
    if (!header || header[2] !== draft.channelId)
      return unverified(`The Slack connector did not report a channel for id ${draft.channelId}.`);
    const account = await read("slack_read_user_profile", {});
    const profile = typeof account.result === "string" ? account.result : "";
    const workspace = /^Organization Name:\s*(.+)$/m.exec(profile)?.[1]?.trim();
    const email = /^Email:\s*(\S+@\S+)$/m.exec(profile)?.[1];
    if (!workspace || !email) return unverified("The Slack connector did not report the sending account's workspace.");
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
        return unverified(`The Slack connector did not report a thread parent for ts ${draft.threadTs}.`);
      thread = parent.messages.slice(0, 500);
    }
    return { identity: `${workspace} (${email})`, destination: header[1]!, thread };
  }
  async create(context: ToolContext, raw: unknown): Promise<string | Record<string, unknown>> {
    const draft = parseExternalDraft(raw);
    const verification = await this.verify(context.botId, context.runId, draft, `draft-verify:${context.callId}`).catch((error: unknown) => {
      // A connector that fails or answers unreadably leaves the routing unverified too; the
      // draft's own refusals (wrong account, wrong from) keep their sentences.
      if (error instanceof ApiError && error.code === "draft_unavailable" && !/^The connector (did not complete|returned an unreadable)/.test(error.message))
        throw error;
      const message = error instanceof Error ? error.message : String(error);
      const reason = /[.!?]$/.test(message) ? message : `${message}.`;
      throw new ApiError(409, "draft_unavailable", `Draft refused: the routing could not be verified through the connector (${reason}). Nothing was drafted. Fix the routing (or the connector's connection) and call this tool again.`);
    });
    if (draft.platform === "slack") draft.target = verification.destination;
    const bot = await this.prisma.bot.findUnique({
      where: { id: context.botId },
      select: { draftingDisabled: true, draftAllowedRecipients: true },
    });
    const mode = externalDraftApprovalMode(
      bot ?? { draftingDisabled: false, draftAllowedRecipients: [] },
      draft
    );
    // The user allowed these recipients or turned drafts off: the card records a send that starts now.
    const sentUnder = draft.waitForReview
      ? undefined
      : mode === "disable-drafts"
        ? { draftingDisabled: true }
        : mode === "always-allow"
          ? { rule: `Allow recipient ${externalDraftRecipients(draft).join(", ")}` }
          : undefined;
    const room = (await this.prisma.channel.findUnique({ where: { id: context.channelId }, select: { kind: true } }))?.kind === "group";
    const result = await this.messaging.sendVisible(context, {
      type: "external-draft",
      draft: { ...draft, verification, runId: context.runId },
      end_turn: false,
      ...(room ? { to: "dm" } : {}),
      ...(sentUnder
        ? { cardState: "sending", sendStartedAt: new Date().toISOString(), sentUnder }
        : {}),
    } as Parameters<AgentMessaging["sendVisible"]>[1]);
    const acknowledgement: string | Record<string, unknown> =
      typeof result.acknowledgement === "string"
        ? result.acknowledgement
        : { ...(result.acknowledgement as Record<string, unknown>), target: verification.destination, ...(room ? { in_dm: true } : {}) };
    if (!sentUnder || typeof acknowledgement === "string" || acknowledgement.duplicate)
      return acknowledgement;
    const delivered = await this.deliver(String(acknowledgement.message_id), false);
    const state = String(metadataRecord(delivered.message.metadata).cardState);
    return {
      ...acknowledgement,
      delivery: state,
      note:
        state === "sent"
          ? `${sentUnder.rule ? `The user allowed ${externalDraftRecipients(draft).join(", ")} for you` : "Your drafts are off"}, so it skipped the review card. Don't send it again.`
          : state === "pending"
            ? `It couldn't be sent automatically (${String(metadataRecord(delivered.message.metadata).sendError)}), so it waits for the user to press Send.`
            : "Check the destination before trying again; it will not be retried automatically.",
    };
  }
  mutate = (messageId: string, raw: unknown) =>
    serviceEffect(async () => {
      const input = metadataRecord(raw);
      if (input.action === "approval") return this.approval(messageId, input.mode, input.edits);
      if (!["save", "send", "cancel", "refresh"].includes(String(input.action)))
        return fail("Choose send, cancel, refresh or approval");
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
            : editExternalDraft(
                parseExternalDraft(stored),
                input.edits,
                strings(metadataRecord(stored.verification).sendingAddresses)
              );
        if (input.action === "refresh") return { message, claimed: false };
        const state =
          input.action === "send" ? "sending" : input.action === "cancel" ? "dismissed" : "pending";
        const { sendError: _sendError, ...rest } = metadata;
        const updated = await tx.channelMessage.update({
          where: { id: messageId },
          data: {
            metadata: toJson({
              ...rest,
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
        return this.settle(messageId, "dismissed", DISCARDED_DRAFT_OUTCOME, false, false);
      if (!claim.claimed) {
        if (metadata.cardState === "sending") {
          const call = await this.prisma.pluginInvocation.findUnique({
            where: { callId: `draft-send:${messageId}:send` },
          });
          if (call?.status === "completed") {
            try {
              connectorRecord(call.result);
              return this.settle(messageId, "sent", "The user sent the reviewed message.");
            } catch {
              return this.settle(messageId, "failed", "The connector reported a send failure.");
            }
          }
          if (Date.now() - Date.parse(String(metadata.sendStartedAt)) > 180_000)
            return this.settle(messageId, "unknown", UNCONFIRMED_DRAFT_OUTCOME, false, false);
        }
        return { accepted: false, message: toChannelMessageView(claim.message), runId: null };
      }
      return this.deliver(messageId);
    });
  /** Sends a card already in the sending state. Failures before the send leave it editable. */
  private async deliver(messageId: string, wake = true) {
    const message = await this.prisma.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
    const metadata = metadataRecord(message.metadata);
    const stored = metadataRecord(metadata.draft);
    const draft = parseExternalDraft(stored);
    const verification = metadataRecord(stored.verification) as Partial<ExternalDraftVerification>;
    const botId = message.senderBotId!;
    const runId = String(stored.runId);
    const sentUnder = metadataRecord(metadata.sentUnder);
    const sent = sentUnder.rule
      ? `Sent without review under the user's rule: ${String(sentUnder.rule)}.`
      : sentUnder.draftingDisabled
        ? "Sent without review because drafts are off for this Bot."
        : "The user sent the reviewed message.";
    let enteredSend = false;
    try {
      const verified = await this.verify(
        botId,
        runId,
        draft,
        `draft-send-verify:${messageId}:${randomUUID()}`
      );
      if (verified.identity !== verification.identity)
        return this.settle(
          messageId,
          "failed",
          "The connector account changed. Nothing was sent; create a new draft for the intended account.",
          wake
        );
      const connection = (await this.connection(draft))!;
      const invoke = async (toolName: string, args: unknown, hostTool = false) =>
        connectorRecord(
          await this.plugins.invoke({
            connectionId: connection.id,
            botId,
            runId,
            callId: `draft-send:${messageId}:send`,
            toolName,
            arguments: args,
            hostTool,
          })
        );
      if (draft.platform === "email") {
        const sendTool = connection.sendTool!;
        const signatureHtml = verified.signatures?.[draft.from!.toLowerCase()];
        enteredSend = true;
        await invoke(
          sendTool,
          {
            action: "send",
            draft: {
              ...emailFields(draft),
              html: externalDraftHtml(draft.body),
              ...(signatureHtml ? { signatureHtml } : {}),
            },
          },
          true
        );
      } else {
        enteredSend = true;
        await invoke("slack_send_message", {
          channel_id: draft.channelId,
          message: draft.body,
          ...(draft.threadTs ? { thread_ts: draft.threadTs } : {}),
        });
      }
      return this.settle(messageId, "sent", sent, wake);
    } catch (error) {
      if (enteredSend) return this.settle(messageId, "unknown", UNCONFIRMED_DRAFT_OUTCOME, false, !wake);
      return this.reopen(
        messageId,
        error instanceof ApiError || error instanceof Error ? error.message : "The connector could not be reached"
      );
    }
  }
  /** Nothing went out: the card stays editable with the reason, and the Bot keeps waiting on it. */
  private reopen(messageId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const { sendStartedAt: _started, sentUnder: _sentUnder, ...metadata } = metadataRecord(message.metadata);
      const updated = await tx.channelMessage.update({
        where: { id: messageId },
        data: {
          metadata: toJson({ ...metadata, cardState: "pending", sendError: reason.slice(0, 500) }),
        },
      });
      await appendEvent(tx, "channel.message.updated", messageId, {
        channelId: message.channelId,
        messageId,
      });
      return { accepted: false, message: toChannelMessageView(updated), runId: null };
    });
  }
  /** The approval menu on a card changes how this Bot's later drafts are reviewed. */
  private approval(messageId: string, rawMode: unknown, edits: unknown) {
    const mode = String(rawMode) as ExternalDraftApprovalMode;
    if (!["always-allow", "needs-approval", "disable-drafts"].includes(mode))
      return fail("Choose always-allow, needs-approval or disable-drafts");
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.channelMessage.findUnique({
        where: { id: messageId },
        include: { channel: true },
      });
      const metadata = metadataRecord(message?.metadata);
      if (!message?.senderBotId || message.channel.archivedAt || metadata.type !== "external-draft")
        return fail("Draft card not found");
      const stored = metadataRecord(metadata.draft);
      // Rules follow the recipients the user sees, including unsent edits.
      const draft =
        edits === undefined
          ? parseExternalDraft(stored)
          : editExternalDraft(
              parseExternalDraft(stored),
              edits,
              strings(metadataRecord(stored.verification).sendingAddresses)
            );
      if (mode === "always-allow" && draft.platform !== "email")
        return fail("Only email recipients can be allowed");
      const bot = await tx.bot.findUniqueOrThrow({
        where: { id: message.senderBotId },
        select: { draftingDisabled: true, draftAllowedRecipients: true },
      });
      await tx.bot.update({
        where: { id: message.senderBotId },
        data:
          mode === "disable-drafts"
            ? { draftingDisabled: true }
            : // Leaving "drafts off" turns review back on without touching recipient rules.
              mode === "needs-approval" && bot.draftingDisabled
              ? { draftingDisabled: false }
              : {
                  draftingDisabled: false,
                  draftAllowedRecipients: externalDraftAllowList(bot.draftAllowedRecipients, draft, mode),
                },
      });
      await appendEvent(tx, "bot.updated", message.senderBotId, {
        botId: message.senderBotId,
        profileChanged: false,
        settingsChanged: true,
      });
      return { accepted: true, message: toChannelMessageView(message), runId: null };
    });
  }
  /** wake: start a turn for the outcome now. echoed: the outcome was already reported, so it is not repeated next turn. */
  private async settle(messageId: string, state: string, outcome: string, wake = true, echoed = !wake) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const metadata = metadataRecord(message.metadata);
      if (metadata.outcomeId)
        return { accepted: false, message: toChannelMessageView(message), runId: null };
      const outcomeId = createHash("sha256").update(`${messageId}:${state}`).digest("hex");
      const stored = metadataRecord(metadata.draft);
      const updated = await tx.channelMessage.update({
        where: { id: messageId },
        data: {
          metadata: toJson({
            ...metadata,
            cardState: state,
            outcomeId,
            outcomeText: `${outcome}\n\n${describeDraft(
              parseExternalDraft(stored),
              metadataRecord(stored.verification)
            )}`.slice(0, 10000),
            // An automatic send reports back in the DraftExternalMessage result instead of a wake.
            outcomeEchoed: echoed,
          }),
        },
      });
      const wakeRun = wake
        ? await this.messaging.enqueueWake(tx, {
            botId: message.senderBotId!,
            channelId: message.channelId,
            origin: "user",
            type: "draft.response",
            content:
              "[SAND_HIDDEN_PROMPT]An external message draft settled. Read its outcome context and continue.",
            clientId: `draft:${messageId}:outcome`,
            priority: PRIORITY.user,
            wrapUserContent: false,
          })
        : null;
      await appendEvent(tx, "channel.message.updated", messageId, {
        channelId: message.channelId,
        messageId,
      });
      await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId!]);
      return { accepted: true, message: toChannelMessageView(updated), runId: wakeRun?.run.id ?? null };
    });
  }
}
