import { describe, expect, test } from "bun:test";
import type { MarkChannelReadView } from "@openteam/contracts";
import { createReadReceiptController } from "../src/read-receipts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const receipt = (sequence: string): MarkChannelReadView => ({
  channelId: "chat",
  lastReadSequence: sequence,
  unreadCount: 0,
});

describe("shared desktop/native read receipts", () => {
  test("serializes each channel and coalesces to the highest pending sequence", async () => {
    const controller = createReadReceiptController();
    const first = deferred<MarkChannelReadView>();
    const sends: Array<string | undefined> = [];
    const acknowledgements: string[] = [];
    const options = {
      send: async (_id: string, through?: string) => {
        sends.push(through);
        return sends.length === 1 ? first.promise : receipt(through!);
      },
      onAcknowledged: (value: MarkChannelReadView) => {
        acknowledgements.push(value.lastReadSequence);
      },
    };
    const request = controller.request("chat", "10", options);
    await Promise.resolve();
    controller.request("chat", "20", options);
    controller.request("chat", "15", options);
    expect(sends).toEqual(["10"]);
    first.resolve(receipt("10"));
    await request;
    expect(sends).toEqual(["10", "20"]);
    expect(acknowledgements).toEqual(["10", "20"]);
    await controller.request("chat", "19", options);
    expect(sends).toHaveLength(2);
  });
  test("discarded account leases cannot publish results or clear a newer request", async () => {
    const controller = createReadReceiptController();
    const old = deferred<MarkChannelReadView>();
    const published: string[] = [];
    const previous = controller.request("chat", "100", {
      send: () => old.promise,
      onAcknowledged: () => {
        published.push("old");
      },
    });
    await Promise.resolve();
    controller.clear();
    await controller.request("chat", "1", {
      send: async () => receipt("1"),
      onAcknowledged: () => {
        published.push("new");
      },
    });
    old.resolve(receipt("100"));
    await previous;
    expect(published).toEqual(["new"]);
    expect(controller.acknowledgedThrough("chat")).toBe("1");
  });
});
