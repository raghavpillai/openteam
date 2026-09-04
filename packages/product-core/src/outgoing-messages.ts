import type { ChannelMessageView } from "@openteam/contracts";
import {
  createDurableSendEchoResolver,
  type DurableSendRecord,
  durableSendIsInFlight,
  durableSendMessage,
  durableSendRenderKey,
} from "./durable-delivery";
import { messageCreatedAtMs } from "./history";
import { messageRenderKey } from "./messages";

export interface OutgoingMessageProjection {
  message: ChannelMessageView;
  renderKey: string;
  pending: boolean;
  delivery: DurableSendRecord | null;
}

export interface OutgoingMessageProjectionOptions {
  /** Native rows retain their optimistic key until the journal retires the send. */
  echoRenderKey?: "message" | "delivery";
  /** Preserve each renderer's existing tie-break for equal timestamps. */
  orderBy?: "renderKey" | "messageId";
}

/** Merge journal records and transcript echoes once, before either renderer adds UI state. */
export const projectOutgoingMessages = (
  messages: readonly ChannelMessageView[],
  deliveries: readonly DurableSendRecord[],
  { echoRenderKey = "message", orderBy = "renderKey" }: OutgoingMessageProjectionOptions = {}
): OutgoingMessageProjection[] => {
  const resolveEcho = createDurableSendEchoResolver(messages, deliveries.length);
  const echoes = new Map(
    deliveries.flatMap((delivery) => {
      const echo = resolveEcho(delivery);
      return echo ? [[delivery.nonce, echo] as const] : [];
    })
  );
  const outgoingIds = new Set(
    deliveries.flatMap((delivery) => {
      const message = echoes.get(delivery.nonce) ?? delivery.acceptedMessage;
      return message ? [message.id] : [];
    })
  );
  const authoritativeById = new Map(messages.map((message) => [message.id, message] as const));
  const projected: OutgoingMessageProjection[] = messages
    .filter((message) => !outgoingIds.has(message.id))
    .map((message) => ({
      message,
      renderKey: messageRenderKey(message),
      pending: false,
      delivery: null,
    }));
  for (const delivery of deliveries) {
    const echo = echoes.get(delivery.nonce);
    projected.push({
      message:
        echo ??
        (delivery.acceptedMessage
          ? authoritativeById.get(delivery.acceptedMessage.id)
          : undefined) ??
        durableSendMessage(delivery),
      renderKey:
        echo && echoRenderKey === "message"
          ? messageRenderKey(echo)
          : durableSendRenderKey(delivery),
      pending: echo ? false : durableSendIsInFlight(delivery),
      delivery: echo
        ? {
            ...delivery,
            phase: "accepted-awaiting-echo",
            acceptedMessage: echo,
            acceptedAtMs: delivery.acceptedAtMs ?? Date.parse(echo.createdAt),
          }
        : delivery,
    });
  }
  return projected.sort(
    (left, right) =>
      messageCreatedAtMs(left.message) - messageCreatedAtMs(right.message) ||
      (orderBy === "messageId"
        ? left.message.id.localeCompare(right.message.id)
        : left.renderKey.localeCompare(right.renderKey))
  );
};
