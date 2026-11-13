import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  ApiError,
  externalDraftAllowList,
  externalDraftApprovalMode,
  externalDraftHtml,
  externalDraftRecipients,
  editExternalDraft,
  parseExternalDraft,
  DRAFT_ATTACHMENT_MAX_BYTES,
  DRAFT_ATTACHMENTS_MAX_BYTES,
  type ExternalDraft,
  type ExternalDraftApprovalMode,
  type ExternalDraftVerification,
} from "@openteam/contracts";
import { draftRevision } from "@openteam/contracts/external-draft-revision";
import { type Prisma, type PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, PRIORITY, draftNotificationVariant, lockDraftNotifications, lockAgentLifecycle } from "@openteam/messaging";
import { loadConnectionNamespaces } from "./plugin/namespaces";
import type { PluginService } from "./plugin-service";
import { definitionFromManifest } from "./plugin/values";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView } from "./view-mappers";
import { connectorRecord, reviewedSendResult } from "./external-draft-result";

// An unconfirmed card is read on the next turn; discards resume the bot immediately.
const DISCARDED_DRAFT_OUTCOME =
  "The user discarded your draft without sending. They refused to send it. Do not send that message yourself (including via CallDynamicTool or any connector send tool), and do not ask them to press Send on it. Treat the draft as rejected; only draft or send again if the user explicitly asks.";
const UNCONFIRMED_DRAFT_OUTCOME =
  "A send of your draft did not confirm. It may or may not have gone out. Do not send that message yourself (including via CallDynamicTool or any connector send tool). Check the destination before drafting or sending it again.";

const fail = (message: string): never => {
  throw new ApiError(409, "draft_unavailable", message);
};
/** The connector could not confirm where a draft goes; create() words it as the reference's refusal. */
const unverified = (reason: string): never => {
  throw new ApiError(409, "draft_route_unverified", reason);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The fields a connector's reviewed-send tool receives. */
const emailFields = (draft: ExternalDraft) => ({
  from: draft.from,
  to: draft.to,
  ...(draft.cc?.length ? { cc: draft.cc } : {}),
  subject: draft.subject,
  body: draft.body,
  ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
  ...(draft.forwardMessageId ? { forwardMessageId: draft.forwardMessageId } : {}),
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
          ...(draft.forwardMessageId ? [`Forwarding: ${verification.forwarding ?? draft.forwardMessageId} (${draft.forwardMessageId})`] : []),
          ...(verification.attachments?.length ? [`Attachments: ${verification.attachments.map((file) => `${file.fileName} (${file.byteSize} bytes)`).join(", ")}`] : []),
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
    private readonly plugins: Pick<PluginService, "invoke">,
    private readonly experiment: { treatmentPercent?: string } = {}
  ) {}
  /**
   * The connection behind a draft's providerIdentifier: its UUID, or the namespace
   * GetMcpServerStatus lists. Includes the declared reviewed-send tool, if any.
   */
  private async connection(draft: ExternalDraft) {
    const identifier = draft.providerIdentifier;
    const id = UUID.test(identifier)
      ? identifier
      : [...(await loadConnectionNamespaces(this.prisma))].find(([, namespace]) => namespace === identifier)?.[0];
    const connection = id
      ? await this.prisma.pluginConnection.findUnique({
          where: { id },
          select: { id: true, alias: true, connectorKey: true, installation: { select: { manifest: true } } },
        })
      : null;
    if (!connection) return undefined;
    const drafts = definitionFromManifest(connection.installation.manifest)?.connections.find(
      (connector) => connector.key === connection.connectorKey
    )?.drafts;
    return { id: connection.id, sendTool: drafts?.platform === draft.platform ? drafts.tool : undefined };
  }
  /** Old cards stored a renameable namespace. Recover its original account only
   * from that card's durable verification calls, never from today's name mapping. */
  private async boundDraft(draft: ExternalDraft, message: { clientId: string | null; senderBotId: string | null }, runId: string) {
    if (UUID.test(draft.providerIdentifier)) return draft;
    const prefix = message.clientId?.startsWith("tool:") ? `draft-verify:${message.clientId.slice(5)}:` : null;
    const calls = prefix ? await this.prisma.pluginInvocation.findMany({
      where: { botId: message.senderBotId!, runId, status: "completed",
        callId: { startsWith: prefix } },
      select: { connectionId: true, callId: true, toolName: true, arguments: true, result: true },
    }) : [];
    const verified = await Promise.all(calls.map(async call => {
      if (call.callId !== `${prefix}${call.toolName}`) return null;
      const args = metadataRecord(call.arguments);
      if (draft.platform === "email") {
        const connection = await this.connection({ ...draft, providerIdentifier: call.connectionId });
        if (call.toolName !== connection?.sendTool || args.action !== "verify") return null;
      } else if (!["slack_read_channel", "slack_read_user_profile", "slack_read_thread"].includes(call.toolName)) return null;
      let result: Record<string, any>;
      try { result = connectorRecord(call.result); } catch { return null; }
      if (draft.platform === "email") {
        if (typeof result.identity !== "string" || !result.identity.trim()) return null;
      } else if (call.toolName === "slack_read_user_profile") {
        if (typeof result.result !== "string" || !/^Organization Name:\s*\S+/m.test(result.result) || !/^Email:\s*\S+@\S+/m.test(result.result)) return null;
      } else {
        if (args.channel_id !== draft.channelId || typeof result.messages !== "string") return null;
        if (call.toolName === "slack_read_channel" && !result.messages.startsWith("Channel:")) return null;
        if (call.toolName === "slack_read_thread" && (args.message_ts !== draft.threadTs || !result.messages.includes(`Message TS: ${draft.threadTs}`))) return null;
      }
      return call.connectionId;
    }));
    const connections = [...new Set(verified.filter((id): id is string => id !== null))];
    if (connections.length !== 1)
      return fail("The original account for this draft could not be verified. Nothing was sent; create a new draft for the intended account.");
    return { ...draft, providerIdentifier: connections[0]! };
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
      if (draft.forwardMessageId && typeof result.forwarding !== "string")
        return unverified("The mailbox did not verify the forwarded message.");
      return {
        identity,
        destination: draft.to!.join(", "),
        sendingAddresses,
        ...(Object.keys(signatures).length ? { signatures } : {}),
        ...(typeof result.thread === "string" ? { thread: result.thread.slice(0, 300) } : {}),
        ...(threadUrl ? { threadUrl } : {}),
        ...(typeof result.forwarding === "string" ? { forwarding: result.forwarding.slice(0, 300) } : {}),
        ...(typeof result.forwardUrl === "string" && /^https:\/\//.test(result.forwardUrl) ? { forwardUrl: result.forwardUrl.slice(0, 2000) } : {}),
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
    const room = (await this.prisma.channel.findUnique({ where: { id: context.channelId }, select: { kind: true } }))?.kind === "group";
    const destination = room
      ? await this.prisma.channel.findFirst({ where: { kind: "bot_dm", archivedAt: null, members: { some: { botId: context.botId } } }, select: { id: true } })
      : { id: context.channelId };
    // A lost response must be recoverable without another connector request or
    // reading mutable source attachments again. The stored card owns this receipt.
    const previous = destination && await this.prisma.channelMessage.findFirst({ where: {
      channelId: destination.id, clientId: `tool:${context.callId}`, senderBotId: context.botId,
    } });
    if (previous) return this.creationReceipt(previous, room, context);
    // Account names can change while the card waits for review. Store the
    // verified connection's stable identity, never a namespace to resolve again.
    const connection = await this.connection(draft);
    if (connection) draft.providerIdentifier = connection.id;
    const verification = await this.verify(context.botId, context.runId, draft, `draft-verify:${context.callId}`).catch((error: unknown) => {
      // A connector that fails or answers unreadably leaves the routing unverified too; the
      // draft's own refusals (wrong account, wrong from) keep their sentences.
      if (error instanceof ApiError && error.code === "draft_unavailable" && !/^The connector (did not complete|returned an unreadable)/.test(error.message))
        throw error;
      const message = error instanceof Error ? error.message : String(error);
      const reason = /[.!?]$/.test(message) ? message : `${message}.`;
      throw new ApiError(409, "draft_unavailable", `Draft refused: the routing could not be verified through the connector (${reason}). Nothing was drafted. Fix the routing (or the connector's connection) and call this tool again.`);
    });
    if (draft.attachments?.length) {
      const attachments = [];
      let total = 0;
      for (const file of draft.attachments) {
        const asset = await this.messaging.assets.ingestSource({ url: pathToFileURL(file).href });
        total += asset.byteSize;
        if (asset.byteSize > DRAFT_ATTACHMENT_MAX_BYTES || total > DRAFT_ATTACHMENTS_MAX_BYTES)
          return fail("Draft attachments must be at most 10 MiB each and 25 MiB combined. Nothing was drafted.");
        attachments.push(asset);
      }
      verification.attachments = attachments;
    }
    // Compare only drafts from preceding user turns, never unrelated bots or the current batch.
    const history = await this.prisma.channelMessage.findMany({
      where: { channelId: context.channelId }, orderBy: { sequence: "desc" }, take: 60,
    });
    let turn = 0;
    const candidates = [];
    for (const message of history) {
      if (message.sender === "user") { if (++turn > 3) break; continue; }
      const metadata = metadataRecord(message.metadata);
      if (turn && message.senderBotId === context.botId && message.sourceRunId !== context.runId && metadata.type === "external-draft") {
        try {
          const previous = parseExternalDraft(metadata.draft);
          candidates.push({ id: message.id, turn,
            draft: await this.boundDraft(previous, message, String(metadataRecord(metadata.draft).runId)) });
        } catch { /* Ignore old, malformed or unverifiable routes. */ }
      }
    }
    verification.revision = draftRevision(draft, candidates);
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
    const result = await this.messaging.sendVisible(context, {
      type: "external-draft",
      draft: { ...draft, verification, runId: context.runId },
      end_turn: false,
      ...(room ? { to: "dm" } : {}),
      ...(sentUnder
        ? { cardState: "sending", sendStartedAt: new Date().toISOString(), sendAttemptId: randomUUID(), sentUnder }
        : {}),
    } as Parameters<AgentMessaging["sendVisible"]>[1]);
    if (typeof result.acknowledgement !== "string" && result.acknowledgement.duplicate) {
      const existing = await this.prisma.channelMessage.findUniqueOrThrow({
        where: { id: String(result.acknowledgement.message_id) },
      });
      return this.creationReceipt(existing, room, context);
    }
    const acknowledgement: string | Record<string, unknown> =
      typeof result.acknowledgement === "string"
        ? result.acknowledgement
        : { ...(result.acknowledgement as Record<string, unknown>), target: verification.destination, ...(room ? { in_dm: true } : {}) };
    if (!sentUnder || typeof acknowledgement === "string" || acknowledgement.duplicate)
      return acknowledgement;
    const delivered = await this.deliver(String(acknowledgement.message_id), false);
    const deliveredMetadata = metadataRecord(delivered.message.metadata);
    const state = String(deliveredMetadata.cardState);
    return {
      ...acknowledgement,
      delivery: state,
      note:
        state === "sent"
          ? `${sentUnder.rule ? `The user allowed ${externalDraftRecipients(draft).join(", ")} for you` : "Your drafts are off"}, so it skipped the review card. Don't send it again.`
          : state === "pending"
            ? `It couldn't be sent automatically (${String(deliveredMetadata.sendError)}), so it waits for the user to press Send.`
            : state === "failed" || state === "unknown"
              ? String(deliveredMetadata.outcomeText ?? (state === "unknown" ? UNCONFIRMED_DRAFT_OUTCOME : "The draft was not delivered.")).split("\n\n", 1)[0]
              : "Check the destination before trying again; it will not be retried automatically.",
    };
  }
  private creationReceipt(message: { id: string; metadata: unknown; senderBotId: string | null; sourceRunId: string | null }, room: boolean, context: ToolContext) {
    if (message.senderBotId !== context.botId || message.sourceRunId !== context.runId)
      return fail("This draft receipt belongs to another run or bot. Nothing was drafted; call this tool again with a new call ID.");
    const metadata = metadataRecord(message.metadata);
    if (metadata.type !== "external-draft")
      return fail("This tool call already delivered a different kind of message. Nothing was drafted; call this tool again.");
    const draft = parseExternalDraft(metadata.draft);
    return { sent: true, duplicate: true, message_id: message.id, message_address: metadata.address,
      platform: draft.platform, from: draft.platform === "email" ? draft.from : undefined,
      target: draft.platform === "email" ? draft.to!.join(", ") : draft.target!, delivery: metadata.cardState ?? "pending",
      note: "This is the existing card; no new draft or send was performed.", ...(room ? { in_dm: true } : {}) };
  }
  mutate = (messageId: string, raw: unknown) =>
    serviceEffect(async () => {
      const input = metadataRecord(raw);
      if (input.action === "approval") return this.approval(messageId, input.mode, input.edits);
      if (!["save", "send", "cancel", "refresh"].includes(String(input.action)))
        return fail("Choose send, cancel, refresh or approval");
      const claim = await this.prisma.$transaction(async (tx) => {
        const owner = await tx.channelMessage.findUnique({ where: { id: messageId }, select: { senderBotId: true } });
        if (owner?.senderBotId) await lockAgentLifecycle(tx, owner.senderBotId);
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
        await lockDraftNotifications(tx, message.senderBotId, message.channelId);
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
              ...(state === "sending" ? { sendStartedAt: new Date().toISOString(), sendAttemptId: randomUUID() } : {}),
            }),
          },
        });
        await appendEvent(tx, "channel.message.updated", messageId, {
          channelId: message.channelId,
          messageId,
        });
        // A persisted discard must always carry the durable outcome/wake. A crash
        // or queue failure cannot leave a terminal card that the agent never hears.
        const settled = input.action === "cancel"
          ? await this.settle(messageId, "dismissed", DISCARDED_DRAFT_OUTCOME, true, false, { transaction: tx })
          : undefined;
        return { message: updated, claimed: input.action === "send", settled };
      });
      if ("settled" in claim && claim.settled) return claim.settled;
      const metadata = metadataRecord(claim.message.metadata);
      if (metadata.cardState === "dismissed" && !metadata.outcomeId)
        return this.settle(messageId, "dismissed", DISCARDED_DRAFT_OUTCOME);
      if (!claim.claimed) {
        if (metadata.cardState === "sending") {
          const sendingAttempt = { startedAt: metadata.sendStartedAt, id: metadata.sendAttemptId };
          const call = await this.prisma.pluginInvocation.findUnique({
            where: { callId: `draft-send:${messageId}:send` },
          });
          if (call?.status === "completed") {
            try {
              const stored = metadataRecord(metadata.draft);
              const draft = await this.boundDraft(parseExternalDraft(stored), claim.message, String(stored.runId));
              const connection = await this.connection(draft);
              if (!connection || call.botId !== claim.message.senderBotId || call.runId !== stored.runId ||
                  call.connectionId !== connection.id || call.toolName !== (draft.platform === "email" ? connection.sendTool : "slack_send_message"))
                throw new Error("The saved connector result does not belong to this draft's bot, run, account and send tool");
              reviewedSendResult(call.result, draft.platform, externalDraftRecipients(draft));
              return this.settle(messageId, "sent", "The user sent the reviewed message.", true, false, { sendingAttempt });
            } catch {
              // Completion records persist connector replies, including unreadable
              // ones. As in live delivery, that cannot establish that nothing sent.
              return this.settle(messageId, "unknown", UNCONFIRMED_DRAFT_OUTCOME, false, false, { sendingAttempt });
            }
          }
          if (Date.now() - Date.parse(String(metadata.sendStartedAt)) > 180_000)
            return this.settle(messageId, "unknown", UNCONFIRMED_DRAFT_OUTCOME, false, false, { sendingAttempt });
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
    let draft = parseExternalDraft(stored);
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
      draft = await this.boundDraft(draft, message, runId);
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
      const invoke = async (toolName: string, args: unknown, hostTool = false) => {
        // Verification and attachment reads can outlive the sending timeout. Claim
        // dispatch under the same lock as refresh; a terminal outcome that wins
        // first must prevent the external operation from starting.
        const blocked = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
          const current = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId }, include: { channel: true } });
          const state = metadataRecord(current.metadata);
          return state.cardState !== "sending" || state.outcomeId || current.channel.archivedAt ||
            state.sendAttemptId !== metadata.sendAttemptId ? current : null;
        });
        if (blocked) return blocked;
        enteredSend = true;
        reviewedSendResult(await this.plugins.invoke({
            connectionId: connection.id,
            botId,
            runId,
            callId: `draft-send:${messageId}:send`,
            toolName,
            arguments: args,
            hostTool,
          }), draft.platform, externalDraftRecipients(draft));
        return null;
      };
      let blocked;
      if (draft.platform === "email") {
        const sendTool = connection.sendTool!;
        const signatureHtml = verified.signatures?.[draft.from!.toLowerCase()];
        const attachments = await this.messaging.assets.normalizeRefs(verification.attachments ?? []);
        if (attachments.length !== (draft.attachments?.length ?? 0))
          return fail("The draft attachments are unavailable. Create a new draft with the intended files.");
        const files = [];
        let total = 0;
        for (const file of attachments) {
          total += file.byteSize;
          if (file.byteSize > DRAFT_ATTACHMENT_MAX_BYTES || total > DRAFT_ATTACHMENTS_MAX_BYTES)
            return fail("The draft attachments exceed the email size limit.");
          const bytes = Buffer.from(await Bun.file(this.messaging.assets.contentPath(file.assetId)).arrayBuffer());
          if (bytes.length !== file.byteSize || createHash("sha256").update(bytes).digest("hex") !== file.assetId)
            return fail("Attachment content cannot be verified. Create a new draft with the intended files.");
          files.push({ filename: file.fileName, mimeType: file.mimeType, content: bytes.toString("base64") });
        }
        blocked = await invoke(
          sendTool,
          {
            action: "send",
            draft: {
              ...emailFields(draft),
              html: externalDraftHtml(draft.body),
              ...(signatureHtml ? { signatureHtml } : {}),
              ...(files.length ? { attachments: files } : {}),
            },
          },
          true
        );
      } else {
        blocked = await invoke("slack_send_message", {
          channel_id: draft.channelId,
          message: draft.body,
          ...(draft.threadTs ? { thread_ts: draft.threadTs } : {}),
        });
      }
      if (blocked) return { accepted: false, message: toChannelMessageView(blocked), runId: null };
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
      await lockDraftNotifications(tx, message.senderBotId!, message.channelId);
      const current = metadataRecord(message.metadata);
      if (current.outcomeId || current.cardState !== "sending")
        return { accepted: false, message: toChannelMessageView(message), runId: null };
      const { sendStartedAt: _started, sendAttemptId: _attempt, sentUnder: _sentUnder, ...metadata } = current;
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
  private async settle(messageId: string, state: string, outcome: string, wake = true, echoed = !wake,
    options: { transaction?: Prisma.TransactionClient; sendingAttempt?: { startedAt: unknown; id: unknown } } = {}) {
    const apply = async (tx: Prisma.TransactionClient) => {
      // Retirement's cancellation snapshot must serialize before or after the
      // complete settlement/wake, using lifecycle -> card -> notification order.
      const owner = await tx.channelMessage.findUnique({ where: { id: messageId }, select: { senderBotId: true } });
      if (owner?.senderBotId) await lockAgentLifecycle(tx, owner.senderBotId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId }, include: { channel: true } });
      const metadata = metadataRecord(message.metadata);
      // A refresh may have read an earlier sending attempt before verification
      // reopened it. Recheck both state and attempt under the mutation lock.
      if (metadata.outcomeId || (state !== "dismissed" && metadata.cardState !== "sending") ||
          (options.sendingAttempt && (metadata.sendStartedAt !== options.sendingAttempt.startedAt ||
            metadata.sendAttemptId !== options.sendingAttempt.id)))
        return { accepted: false, message: toChannelMessageView(message), runId: null };
      const outcomeId = createHash("sha256").update(`${messageId}:${state}`).digest("hex");
      const bot = await tx.bot.findUnique({ where: { id: message.senderBotId! }, select: { status: true } });
      const shouldWake = wake && bot?.status === "active" && !message.channel.archivedAt;
      const treatment = shouldWake && draftNotificationVariant(message.senderBotId!, this.experiment.treatmentPercent) === "treatment";
      await lockDraftNotifications(tx, message.senderBotId!, message.channelId);
      const stored = metadataRecord(metadata.draft);
      const draft = parseExternalDraft(stored);
      // Carry identity in the wake itself, even if another turn already consumed ambient outcomes.
      // Full content remains in the card receipt; keep the wake compact for large batches.
      const identity = draft.platform === "email"
        ? { platform: "email", from: draft.from, to: draft.to!.slice(0, 3), recipientCount: draft.to!.length, subject: draft.subject!.slice(0, 300) }
        : { platform: "slack", target: draft.target, channelId: draft.channelId, threadTs: draft.threadTs };
      const notice = `[Card outcome ${outcomeId}]\nDraft card ID: ${messageId}\nState: ${state}\n${JSON.stringify(identity)}\n${outcome}`;
      const updated = await tx.channelMessage.update({
        where: { id: messageId },
        data: {
          metadata: toJson({
            ...metadata,
            cardState: state,
            outcomeId,
            ...(treatment ? { draftNotification: { variant: "treatment" } } : {}),
            outcomeText: `${outcome}\n\n${describeDraft(
              draft,
              metadataRecord(stored.verification)
            )}`.slice(0, 10000),
            // An automatic send reports back in the DraftExternalMessage result instead of a wake.
            outcomeEchoed: echoed,
          }),
        },
      });
      const wakeRun = shouldWake
        ? await this.messaging.enqueueDraftOutcome(tx, {
            botId: message.senderBotId!,
            channelId: message.channelId,
            origin: "user",
            type: "draft.response",
            content: `[SAND_HIDDEN_PROMPT]${notice}\nRead the stored card outcome for full content. Acknowledge newly settled drafts briefly, then continue without repeating already reported results. Do not infer other cards are still open merely because their outcomes are absent.`,
            clientId: `draft:${messageId}:outcome`,
            priority: PRIORITY.user,
            wrapUserContent: false,
          }, treatment)
        : null;
      await appendEvent(tx, "channel.message.updated", messageId, {
        channelId: message.channelId,
        messageId,
      });
      await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId!]);
      return { accepted: true, message: toChannelMessageView(updated), runId: wakeRun?.run.id ?? null };
    };
    return options.transaction ? apply(options.transaction) : this.prisma.$transaction(apply);
  }
}
