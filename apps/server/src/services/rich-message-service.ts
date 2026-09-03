import {
  ApiError,
  type ChannelMessageView,
  type ComputerHandoffMutationInput,
  type RichMessageMutationView,
  type SecretSubmissionInput,
  type WidgetDismissInput,
  type WidgetResponseInput,
} from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import { type AgentMessaging, PRIORITY } from "@openbot/messaging";
import { Effect } from "effect";
import type { PluginService } from "./plugin-service";
import type { ScreenService } from "./screen-service";
import { appendEvent, toError, toJson } from "./service-utils";

type Metadata = Record<string, unknown>;

const metadataRecord = (value: unknown): Metadata =>
  value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Metadata) } : {};

const stringRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const messageView = (message: {
  id: string;
  clientId?: string | null;
  sequence: bigint;
  channelId: string;
  sender: string;
  senderBotId: string | null;
  sourceRunId: string | null;
  content: string;
  metadata: unknown;
  createdAt: Date;
}): ChannelMessageView => ({
  id: message.id,
  ...(typeof message.clientId === "string" ? { clientId: message.clientId } : {}),
  sequence: message.sequence.toString(),
  channelId: message.channelId,
  sender: message.sender as ChannelMessageView["sender"],
  senderBotId: message.senderBotId,
  sourceRunId: message.sourceRunId,
  content: message.content,
  metadata: message.metadata,
  createdAt: message.createdAt.toISOString(),
});

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
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly plugins: PluginService,
    private readonly screens: ScreenService
  ) {}

  respondToWidget = (messageId: string, input: WidgetResponseInput) =>
    Effect.tryPromise({
      try: async (): Promise<RichMessageMutationView> =>
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
                respondedValueEchoed: true,
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
        }),
      catch: toError,
    });

  dismissWidget = (messageId: string, input: WidgetDismissInput) =>
    Effect.tryPromise({
      try: async (): Promise<RichMessageMutationView> =>
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
        }),
      catch: toError,
    });

  submitSecret = (messageId: string, input: SecretSubmissionInput) =>
    Effect.tryPromise({
      try: async (): Promise<RichMessageMutationView> => {
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
            typeof request.connector !== "string" ||
            typeof request.field !== "string"
          ) {
            throw new ApiError(404, "secret_request_not_found", "Live secret request not found");
          }
          if (metadata.secretProvided === true) {
            return { accepted: false, message: messageView(message), runId: null };
          }
          await this.plugins.storeConnectorSecret({
            botId: message.senderBotId,
            connector: request.connector,
            field: request.field,
            value,
          });
          const wake = await this.messaging.enqueueWake(tx, {
            botId: message.senderBotId,
            channelId: message.channelId,
            origin: "handoff_resume",
            type: "secret.provided",
            content: buildSecretProvidedAck(request.label),
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
      },
      catch: toError,
    });

  mutateComputerHandoff = (messageId: string, input: ComputerHandoffMutationInput) =>
    Effect.tryPromise({
      try: async (): Promise<RichMessageMutationView> =>
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
        }),
      catch: toError,
    });
}
