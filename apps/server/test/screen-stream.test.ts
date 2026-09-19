import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { PrismaClient } from "@openteam/db";
import { ScreenService } from "../src/services/screen-service";

test("screen stream passes bytes incrementally and propagates reader cancellation", async () => {
  let cancelled = false;
  let upstreamSignal: AbortSignal | undefined;
  const abort = new AbortController();
  const service = new ScreenService(
    {
      bot: {
        findUnique: async () => ({ id: "bot", status: "active", defaultDirectory: "/workspace" }),
      },
    } as unknown as PrismaClient,
    "/data",
    "localhost",
    async (path, init) => {
      expect(path).toBe("/v1/screens/bot/stream?cwd=%2Fworkspace");
      upstreamSignal = init.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel() {
            cancelled = true;
          },
        })
      );
    }
  );
  const body = await Effect.runPromise(service.stream("bot", abort.signal));
  const reader = body.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
  abort.abort();
  expect(upstreamSignal?.aborted).toBe(true);
  await reader.cancel();
  expect(cancelled).toBe(true);
});

test("archived bots cannot start a stream and upstream errors stay private", async () => {
  let calls = 0;
  let active = false;
  const service = new ScreenService(
    {
      bot: {
        findUnique: async () => ({
          id: "bot",
          status: active ? "active" : "archived",
          defaultDirectory: "/workspace",
        }),
      },
    } as unknown as PrismaClient,
    "/data",
    "localhost",
    async () => {
      calls++;
      return new Response("private upstream details", { status: 500 });
    }
  );
  await expect(
    Effect.runPromise(service.stream("bot", new AbortController().signal))
  ).rejects.toThrow("Active bot not found");
  expect(calls).toBe(0);
  active = true;
  await expect(
    Effect.runPromise(service.stream("bot", new AbortController().signal))
  ).rejects.toThrow("Computer video is unavailable");
});
