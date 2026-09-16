import type { BotService } from "./bot-service";
import { storeProcessSecret } from "./process-secrets";
import { ReviewActionService } from "./review-action-service";
import {
  ApiError,
  type ComputerHandoffMutationInput,
  type RichMessageMutationView,
  type SecretSubmissionInput,
  type WidgetDismissInput,
  type WidgetResponseInput,
  parseUserForm,
  parseUserFormReceipt,
  formatUserFormReceipt,
  type UserFormReceipt,
} from "@openteam/contracts";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, PRIORITY } from "@openteam/messaging";
import { Effect } from "effect";
import type { PluginService } from "./plugin-service";
import type { ScreenService } from "./screen-service";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView as messageView } from "./view-mappers";

import { ExternalDraftService } from "./external-draft-service";

type Metadata = Record<string, unknown>;

const stringRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const widgetOptions = (widget: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(widget.options)
    ? widget.options.filter(
        (option): option is Record<string, unknown> =>
          Boolean(option) && typeof option === "object" && !Array.isArray(option)
      )
    : [];

const effectiveOptionValue = (option: Record<string, unknown>): string | null =>
  typeof option.value === "string"
    ? option.value
    : typeof option.label === "string"
      ? option.label
      : null;

const responseLabel = (widget: Record<string, unknown>, value: string): string => {
  const options = widgetOptions(widget);
  const labels = new Map(
    options.flatMap((option) => {
      const optionValue = effectiveOptionValue(option);
      return optionValue && typeof option.label === "string"
        ? [[optionValue, option.label] as const]
        : [];
    })
  );
  if (widget.multiSelect !== true) return labels.get(value) ?? value;
  return value
    .split("\n")
    .map((part) => labels.get(part) ?? part)
    .join("\n");
};

const assertWidgetAnswer = (widget: Record<string, unknown>, rawValue: string): string => {
  const value = rawValue.trim();
  if (!value) throw new ApiError(400, "widget_answer_required", "A widget answer is required");
  const allowed = new Set(
    widgetOptions(widget).flatMap((option) => {
      const optionValue = effectiveOptionValue(option);
      return optionValue === null ? [] : [optionValue];
    })
  );
  const values = widget.multiSelect === true ? value.split("\n") : [value];
  const selectedAreKnown = values.every((candidate) => allowed.has(candidate));
  if (!selectedAreKnown && widget.allowCustom !== true) {
    throw new ApiError(400, "widget_answer_invalid", "That answer is not available on this widget");
  }
  return value;
};

export const buildSecretProvidedAck = (label: string, targetKind = "channel-credential"): string =>
  `[The user securely provided the requested secret: ${JSON.stringify(label)}. It was written straight to its destination (${targetKind}); you never see the value and it is not in this conversation.]\nConfirm to the user that it is set, then continue. For a connector credential, the connection links within a few seconds, so you can check and report its status.`;

export const buildComputerHandoffResume = (outcome: "complete" | "skip" | "dismiss"): string =>
  outcome === "complete"
    ? "[The user finished the requested computer handoff. Inspect the screen, confirm the result, and continue from where you paused.]"
    : "[The user skipped or closed the requested computer handoff. Continue without repeating the request unless the manual step is essential.]";

export const dismissMoveOnWidgets = async (
  tx: Prisma.TransactionClient,
  channelId: string
): Promise<number> =>
  tx.$executeRaw(Prisma.sql`
    UPDATE "ChannelMessage"
    SET "metadata" = "metadata" || '{"widgetDismissed":true,"widgetSkipped":true}'::jsonb
    WHERE "channelId" = ${channelId}::uuid
      AND "sender" = 'agent'::"ChannelMessageSender"
      AND "metadata"->>'type' = 'widget'
      AND coalesce(("metadata"->'widget'->>'dismissOnMoveOn')::boolean, false) = true
      AND NOT ("metadata" ? 'respondedValue')
      AND coalesce(("metadata"->>'widgetDismissed')::boolean, false) = false
  `);

export class RichMessageService {
  readonly reviewActions: ReviewActionService;
  readonly externalDrafts: ExternalDraftService;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly plugins: PluginService,
    private readonly screens: ScreenService,
    bots?: BotService
  ) { this.externalDrafts = new ExternalDraftService(prisma, messaging, plugins); this.reviewActions = new ReviewActionService(prisma, messaging, bots); }

  private recovering: Promise<void> | null = null;
  recoverPendingReviews(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      const messages = await this.prisma.channelMessage.findMany({ where: { channel: { archivedAt: null }, AND: [{ metadata: { path: ["cardState"], equals: "sending" } }, { OR: [{ metadata: { path: ["type"], equals: "external-draft" } }, { metadata: { path: ["type"], equals: "review-action" } }] }] }, orderBy: { sequence: "asc" }, take: 100 });
      for (const message of messages) {
        const service = metadataRecord(message.metadata).type === "external-draft" ? this.externalDrafts : this.reviewActions;
        await Effect.runPromise(service.mutate(message.id, { action: "refresh" }));
      }
    })().finally(() => { this.recovering = null; });
    return this.recovering;
  }

  async createUserForm(context: ToolContext, raw: unknown) {
    const form = parseUserForm(raw);
    const id = createHash("sha256").update(`${context.botId}:${context.callId}`).digest("hex");
    const prepared = await this.screens.userFormAction(context.botId, id, "prepare", { form });
    const result = await this.messaging.sendVisible(context, { type: "user-form", form: { ...parseUserForm(prepared), id }, end_turn: true });
    return {...result.acknowledgement as Record<string,unknown>,...(typeof metadataRecord(prepared).preflightNote === "string" ? {preflightNote:metadataRecord(prepared).preflightNote} : {})};
  }

  async recordFormRemap(botId: string, raw: unknown) {
    const receipt = parseUserFormReceipt(raw);
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.channelMessage.findFirst({ where: { senderBotId: botId, metadata: { path: ["form", "id"], equals: receipt.formId } } });
      if (!message) throw new ApiError(404, "form_unavailable", "Form card not found");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${message.id}`}))`;
      const current = await tx.channelMessage.findUniqueOrThrow({ where: { id: message.id } });
      const metadata = metadataRecord(current.metadata);
      const outcomeId = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
      if (metadata.outcomeId === outcomeId) return { messageId: message.id, outcomeId };
      await tx.channelMessage.update({ where: { id: message.id }, data: { metadata: toJson({ ...metadata, formReceipt: receipt, outcomeId, outcomeText: formatUserFormReceipt(receipt), outcomeEchoed: false }) } });
      await appendEvent(tx, "channel.message.updated", message.id, { channelId: message.channelId, messageId: message.id, reason: "form-remap" });
      await this.messaging.scheduleTranscriptProjection(tx, [botId]);
      return { messageId: message.id, outcomeId };
    });
  }

  formPrefill = (messageId: string) => serviceEffect(async () => {
    const message = await this.prisma.channelMessage.findUnique({ where: { id: messageId }, include: { channel: true } });
    const metadata = metadataRecord(message?.metadata); const form = stringRecord(metadata.form);
    if (!message?.senderBotId || message.channel.archivedAt || metadata.type !== "user-form" || !form || typeof form.id !== "string" || metadata.cardState === "submitted" || metadata.cardState === "dismissed") throw new ApiError(404, "form_unavailable", "Pending form not found");
    return this.screens.userFormAction(message.senderBotId, form.id, "prefill", {});
  });

  submitUserForm = (messageId: string, raw: unknown) => serviceEffect(async (): Promise<RichMessageMutationView> => {
    const input = stringRecord(raw);
    if (!input || !["submit", "dismiss"].includes(String(input.action))) throw new ApiError(400, "form_action_invalid", "Choose submit or dismiss");
    const message = await this.prisma.channelMessage.findUnique({ where: { id: messageId }, include: { channel: true } });
    const metadata = metadataRecord(message?.metadata); const form = stringRecord(metadata.form);
    if (!message?.senderBotId || message.channel.archivedAt || metadata.type !== "user-form" || !form || typeof form.id !== "string") throw new ApiError(404, "form_unavailable", "Form not found");
    if (metadata.cardState === "submitted" || metadata.cardState === "dismissed") return { accepted: false, message: messageView(message), runId: null };
    // The request values stay on the human-to-host path. No database, event,
    // transcript, wake, log or returned message receives this object.
    const receipt = parseUserFormReceipt(await this.screens.userFormAction(message.senderBotId, form.id, input.action as "submit" | "dismiss", { values: input.values, saveToVault: input.saveToVault === true }));
    if (receipt.formId !== form.id) throw new ApiError(502, "form_receipt_mismatch", "The host returned a different form receipt");
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const current = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const currentMetadata = metadataRecord(current.metadata);
      if (currentMetadata.cardState === "submitted" || currentMetadata.cardState === "dismissed") return { accepted: false, message: messageView(current), runId: null };
      const updated = await tx.channelMessage.update({ where: { id: messageId }, data: { metadata: toJson({
        ...currentMetadata, cardState: receipt.status, formReceipt: receipt, outcomeId: randomUUID(), outcomeText: formatUserFormReceipt(receipt), outcomeEchoed: false,
      }) } });
      const wake = await this.messaging.enqueueWake(tx, { botId: message.senderBotId!, channelId: message.channelId, origin: "user", type: "form.response", content: `[SAND_HIDDEN_PROMPT]The user ${receipt.status} the form. Read its host-provided outcome context and continue.`, clientId: `form:${messageId}:response`, priority: PRIORITY.user, wrapUserContent: false });
      await appendEvent(tx, "channel.message.updated", messageId, { channelId: message.channelId, messageId, reason: "form-response" });
      await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId!]);
      return { accepted: true, message: messageView(updated), runId: wake.run.id };
    });
  });

  respondToWidget = (messageId: string, input: WidgetResponseInput) =>
    serviceEffect(
      async (): Promise<RichMessageMutationView> =>
        this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
          const message = await tx.channelMessage.findUnique({
            where: { id: messageId },
            include: { channel: true },
          });
          const metadata = metadataRecord(message?.metadata);
          const widget = stringRecord(metadata.widget);
          if (
            !message ||
            message.sender !== "agent" ||
            !message.senderBotId ||
            message.channel.archivedAt ||
            metadata.type !== "widget" ||
            !widget
          ) {
            throw new ApiError(404, "widget_not_found", "Live widget not found");
          }
          if (typeof metadata.respondedValue === "string" || metadata.widgetDismissed === true) {
            return { accepted: false, message: messageView(message), runId: null };
          }
          const value = assertWidgetAnswer(widget, input.value);
          const clientId = `widget:${message.id}:response`;
          const wake = await this.messaging.enqueueWake(tx, {
            botId: message.senderBotId,
            channelId: message.channelId,
            origin: "user",
            type: "widget.response",
            content: value,
            clientId,
            priority: PRIORITY.user,
            wrapUserContent: false,
          });
          const updated = await tx.channelMessage.update({
            where: { id: message.id },
            data: {
              metadata: toJson({
                ...metadata,
                respondedValue: value,
                respondedLabel: responseLabel(widget, value),
                respondedValueEchoed: false,
                outcomeId: `${message.id}:response`, outcomeText: `The user answered ${JSON.stringify(message.content)}: ${JSON.stringify(responseLabel(widget, value))}`, outcomeEchoed: false,
                widgetResponseClientId: input.clientId,
              }),
            },
          });
          await appendEvent(tx, "channel.message.updated", message.id, {
            channelId: message.channelId,
            messageId: message.id,
            reason: "widget-response",
          });
          await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId]);
          return { accepted: true, message: messageView(updated), runId: wake.run.id };
        })
    );

  dismissWidget = (messageId: string, input: WidgetDismissInput) =>
    serviceEffect(
      async (): Promise<RichMessageMutationView> =>
        this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
          const message = await tx.channelMessage.findUnique({
            where: { id: messageId },
            include: { channel: true },
          });
          const metadata = metadataRecord(message?.metadata);
          if (
            !message ||
            message.sender !== "agent" ||
            !message.senderBotId ||
            message.channel.archivedAt ||
            metadata.type !== "widget" ||
            !stringRecord(metadata.widget)
          ) {
            throw new ApiError(404, "widget_not_found", "Live widget not found");
          }
          if (typeof metadata.respondedValue === "string" || metadata.widgetDismissed === true) {
            return { accepted: false, message: messageView(message), runId: null };
          }
          const updated = await tx.channelMessage.update({
            where: { id: message.id },
            data: {
              metadata: toJson({
                ...metadata,
                widgetDismissed: true,
                widgetDismissClientId: input.clientId,
              }),
            },
          });
          await appendEvent(tx, "channel.message.updated", message.id, {
            channelId: message.channelId,
            messageId: message.id,
            reason: "widget-dismissed",
          });
          await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId]);
          return { accepted: true, message: messageView(updated), runId: null };
        })
    );

  submitSecret = (messageId: string, input: SecretSubmissionInput) =>
    serviceEffect(async (): Promise<RichMessageMutationView> => {
      const value = input.value;
      if (!value.trim()) throw new ApiError(400, "secret_required", "A secret value is required");
      return this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
        const message = await tx.channelMessage.findUnique({
          where: { id: messageId },
          include: { channel: true },
        });
        const metadata = metadataRecord(message?.metadata);
        const request = stringRecord(metadata.secretRequest) ?? stringRecord(metadata.secret);
        if (
          !message ||
          message.sender !== "agent" ||
          !message.senderBotId ||
          message.channel.archivedAt ||
          metadata.type !== "secret-request" ||
          !request ||
          typeof request.label !== "string" ||
          (typeof request.name !== "string" && (typeof request.connector !== "string" || typeof request.field !== "string"))
        ) {
          throw new ApiError(404, "secret_request_not_found", "Live secret request not found");
        }
        if (metadata.secretProvided === true) {
          return { accepted: false, message: messageView(message), runId: null };
        }
        const named = typeof request.name === "string";
        if (named) await storeProcessSecret(tx, message.senderBotId, message.channelId, String(request.name), value, request.scope === "personal" ? "personal" : "bot");
        else await this.plugins.storeConnectorSecret({ botId: message.senderBotId, connector: String(request.connector), field: String(request.field), value });
        const acknowledgement = named
          ? `[The user securely provided ${JSON.stringify(request.label)}. It is available to new box processes as process.env.${request.name}; its value never enters this conversation. Shell output containing it is redacted. Do not print it to verify it.]`
          : buildSecretProvidedAck(request.label);
        const wake = await this.messaging.enqueueWake(tx, {
          botId: message.senderBotId,
          channelId: message.channelId,
          origin: "handoff_resume",
          type: "secret.provided",
          content: acknowledgement,
          clientId: `secret:${message.id}:provided`,
          priority: PRIORITY.user,
          wrapUserContent: false,
        });
        const updated = await tx.channelMessage.update({
          where: { id: message.id },
          data: {
            metadata: toJson({
              ...metadata,
              secretProvided: true,
              outcomeId: `${message.id}:provided`, outcomeText: acknowledgement, outcomeEchoed: false,
              secretSubmissionClientId: input.clientId,
            }),
          },
        });
        await appendEvent(tx, "channel.message.updated", message.id, {
          channelId: message.channelId,
          messageId: message.id,
          reason: "secret-provided",
        });
        await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId]);
        return { accepted: true, message: messageView(updated), runId: wake.run.id };
      });
    });

  mutateComputerHandoff = (messageId: string, input: ComputerHandoffMutationInput) =>
    serviceEffect(
      async (): Promise<RichMessageMutationView> =>
        this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
          const message = await tx.channelMessage.findUnique({
            where: { id: messageId },
            include: { channel: true },
          });
          const metadata = metadataRecord(message?.metadata);
          const handoff = stringRecord(metadata.computerHandoff);
          if (
            !message ||
            message.sender !== "agent" ||
            !message.senderBotId ||
            message.channel.archivedAt ||
            metadata.type !== "computer-handoff" ||
            !handoff ||
            typeof handoff.reason !== "string"
          ) {
            throw new ApiError(
              404,
              "computer_handoff_not_found",
              "Live computer handoff not found"
            );
          }

          const state =
            typeof metadata.computerHandoffState === "string"
              ? metadata.computerHandoffState
              : "requested";
          if (["completed", "skipped", "dismissed"].includes(state)) {
            return { accepted: false, message: messageView(message), runId: null };
          }

          if (input.action === "start") {
            await Effect.runPromise(this.screens.takeover(message.senderBotId, true));
            if (state === "active") {
              return { accepted: false, message: messageView(message), runId: null };
            }
            const updated = await tx.channelMessage.update({
              where: { id: message.id },
              data: {
                metadata: toJson({
                  ...metadata,
                  computerHandoffState: "active",
                  computerHandoffClientId: input.clientId,
                }),
              },
            });
            await appendEvent(tx, "channel.message.updated", message.id, {
              channelId: message.channelId,
              messageId: message.id,
              reason: "computer-handoff-started",
            });
            await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId]);
            return { accepted: true, message: messageView(updated), runId: null };
          }

          await Effect.runPromise(this.screens.takeover(message.senderBotId, false));
          const finalState =
            input.action === "complete"
              ? "completed"
              : input.action === "skip"
                ? "skipped"
                : "dismissed";
          const wake = await this.messaging.enqueueWake(tx, {
            botId: message.senderBotId,
            channelId: message.channelId,
            origin: "handoff_resume",
            type: `computer-handoff.${finalState}`,
            content: buildComputerHandoffResume(input.action),
            clientId: `computer-handoff:${message.id}:resume`,
            priority: PRIORITY.user,
            wrapUserContent: false,
          });
          const updated = await tx.channelMessage.update({
            where: { id: message.id },
            data: {
              metadata: toJson({
                ...metadata,
                computerHandoffState: finalState,
                outcomeId: `${message.id}:${finalState}`, outcomeText: buildComputerHandoffResume(input.action), outcomeEchoed: false,
                computerHandoffClientId: input.clientId,
              }),
            },
          });
          await appendEvent(tx, "channel.message.updated", message.id, {
            channelId: message.channelId,
            messageId: message.id,
            reason: `computer-handoff-${finalState}`,
          });
          await this.messaging.scheduleTranscriptProjection(tx, [message.senderBotId]);
          return { accepted: true, message: messageView(updated), runId: wake.run.id };
        })
    );
}
