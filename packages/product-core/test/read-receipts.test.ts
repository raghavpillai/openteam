import { describe, expect, test } from "bun:test";
import type { MarkChannelReadView } from "@openteam/contracts";
import { createReadReceiptController, readReceiptTarget } from "../src/read-receipts";

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
  test("clamps visible sequences without losing integer precision", () => {
    expect(readReceiptTarget("9007199254740993", "9007199254740994")).toBe("9007199254740993");
    expect(readReceiptTarget("20", "10")).toBe("10");
    expect(readReceiptTarget("20")).toBe("20");
    expect(readReceiptTarget(null)).toBeNull();
    expect(readReceiptTarget("20", "-1")).toBeNull();
    expect(readReceiptTarget("local")).toBeNull();
  });
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
  test("accepts a trailing read queued by the acknowledgement callback", async () => {
    const controller = createReadReceiptController();
    const sends: string[] = [];
    const options = {
      send: async (_id: string, through?: string) => {
        sends.push(through!);
        return receipt(through!);
      },
      onAcknowledged: () => {
        if (sends.length === 1) void controller.request("chat", "11", options);
      },
    };
    await controller.request("chat", "10", options);
    expect(sends).toEqual(["10", "11"]);
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
  test("retries failures and partial acknowledgements without a tight loop", async () => {
    const controller = createReadReceiptController();
    let calls = 0;
    const failures: unknown[] = [];
    const options = {
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return receipt(calls === 2 ? "5" : "10");
      },
      onError: (cause: unknown) => {
        failures.push(cause);
      },
    };
    await controller.request("chat", "10", options);
    expect(failures).toHaveLength(1);
    expect(controller.hasState("chat")).toBe(true);
    await controller.request("chat", "10", options);
    expect(calls).toBe(2);
    await controller.request("chat", "10", options);
    expect(controller.acknowledgedThrough("chat")).toBe("10");
  });
  test("preserves the desktop's unspecified-sequence fallback", async () => {
    const controller = createReadReceiptController();
    const sent: unknown[] = [];
    await controller.request("chat", undefined, {
      send: async (_id, through) => {
        sent.push(through);
        return receipt("9");
      },
    });
    expect(sent).toEqual([undefined]);
    expect(controller.acknowledgedThrough("chat")).toBe("9");
  });
});
