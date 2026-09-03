import type { DurableSendTelemetryEvent } from "@openteam/product-core/durable-delivery";

const MAX_DELIVERY_EVENTS = 200;
const events: DurableSendTelemetryEvent[] = [];

export const recordMobileDeliveryTelemetry = (event: DurableSendTelemetryEvent): void => {
  events.push(event);
  if (events.length > MAX_DELIVERY_EVENTS) {
    events.splice(0, events.length - MAX_DELIVERY_EVENTS);
  }
};

export const mobileDeliveryTelemetrySnapshot = (): readonly DurableSendTelemetryEvent[] =>
  events.slice();
