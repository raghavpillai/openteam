import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { forwardServiceMethod, metadataRecord, serviceEffect } from "../src/services/service-utils";
import { toChannelMessageView } from "../src/services/view-mappers";

describe("shared service adapters", () => {
  test("service forwarding is lazy, preserves bound receivers, and resolves replacements", async () => {
    class Service {
      constructor(readonly prefix: string) {}
      run = (value: string) => Promise.resolve(`${this.prefix}:${value}`);
    }
    let service: Service;
    const forward = forwardServiceMethod(() => service.run);
    service = new Service("first");
    const detached = forward;
    expect(await detached("value")).toBe("first:value");
    service = new Service("second");
    expect(await detached("value")).toBe("second:value");
    const pending = Promise.resolve("same promise");
    service.run = () => pending;
    expect(detached("value")).toBe(pending);
  });

  test("promise effects remain lazy, repeatable, and receive the cancellation signal", async () => {
    let calls = 0;
    const effect = serviceEffect(async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return ++calls;
    });
    expect(calls).toBe(0);
    expect(await Effect.runPromise(effect)).toBe(1);
    expect(await Effect.runPromise(effect)).toBe(2);
  });

  test("preserves Error identity and normalizes other promise failures", async () => {
    const failure = new Error("original failure");
    for (const cause of [failure, "string failure"]) {
      const result = await Effect.runPromise(
        Effect.either(
          serviceEffect(async () => {
            throw cause;
          })
        )
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(Error);
        expect(result.left.message).toBe(cause instanceof Error ? cause.message : cause);
        if (cause instanceof Error) expect(result.left).toBe(cause);
      }
    }
  });

  test("metadata copies remain shallow and reject non-record values", () => {
    const nested = { important: true };
    const input = { nested, label: "before" };
    const output = metadataRecord(input);
    output.label = "after";
    expect(input.label).toBe("before");
    expect(output.nested).toBe(nested);
    for (const value of [null, undefined, [], "text", 1]) expect(metadataRecord(value)).toEqual({});
  });

  test("message projections preserve metadata and optional client-id semantics", () => {
    const metadata = { branched: true, replyTo: "original" };
    const message = {
      id: "message",
      clientId: null,
      sequence: 9007199254740993n,
      channelId: "channel",
      sender: "agent",
      senderBotId: "bot",
      sourceRunId: null,
      content: "hello",
      metadata,
      createdAt: new Date("2026-09-01T12:00:00.000Z"),
    };
    const view = toChannelMessageView(message);
    expect(view.sequence).toBe("9007199254740993");
    expect(view.createdAt).toBe("2026-09-01T12:00:00.000Z");
    expect(view.metadata).toBe(metadata);
    expect("clientId" in view).toBe(false);
    expect(toChannelMessageView({ ...message, clientId: "" }).clientId).toBe("");
    expect(message.createdAt).toBeInstanceOf(Date);
  });
});
