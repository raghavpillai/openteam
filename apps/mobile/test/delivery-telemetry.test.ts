import { expect, test } from "bun:test";
import type { DurableSendTelemetryEvent } from "@openteam/product-core/durable-delivery";
import {
  mobileDeliveryTelemetrySnapshot,
  recordMobileDeliveryTelemetry,
} from "../src/delivery-telemetry";

test("mobile delivery diagnostics stay bounded and retain the newest transitions", () => {
  for (let index = 0; index < 205; index += 1) {
    recordMobileDeliveryTelemetry({
      outcome: "accepted",
      nonce: `nonce-${index}`,
      lineageId: `lineage-${index}`,
      channelId: "channel-1",
      atMs: index,
      ageMs: index,
      attemptCount: 1,
      attachmentCount: 0,
      queued: false,
    } satisfies DurableSendTelemetryEvent);
  }

  const snapshot = mobileDeliveryTelemetrySnapshot();
  expect(snapshot).toHaveLength(200);
  expect(snapshot[0]?.nonce).toBe("nonce-5");
  expect(snapshot.at(-1)?.nonce).toBe("nonce-204");
});
