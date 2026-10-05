import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { ScreenClipboardInput } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { ScreenService } from "../src/services/screen-service";
import { botRoutes } from "../src/routes/bot";
import type { RouteContext } from "../src/routes/context";

test("clipboard route preserves Unicode and forwards cancellation to the assigned computer", async () => {
  const abort = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  const service = new ScreenService({ bot: { findUnique: async () => ({ id: "bot", status: "active", defaultDirectory: "/workspace/bot" }) } } as unknown as PrismaClient,
    "/data", "localhost", async (path, init) => {
      expect(path).toBe("/v1/screens/bot/clipboard");
      expect(JSON.parse(String(init.body))).toEqual({ cwd: "/workspace/bot", input: { action: "paste", text: "👋 日本語\nsecond line", shift: true } });
      upstreamSignal = init.signal;
      return Response.json({});
    });
  const request = new Request("http://localhost/api/v0/bots/bot/screen/clipboard", { method: "POST", signal: abort.signal,
    body: JSON.stringify({ action: "paste", text: "👋 日本語\nsecond line", shift: true }) });
  const response = await botRoutes({ app: { screenClipboard: service.clipboard }, request, url: new URL(request.url), path: "/api/bots/bot/screen/clipboard" } as unknown as RouteContext);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toContain("no-store");
  abort.abort();
  expect(upstreamSignal?.aborted).toBe(true);
});

test("inactive bots cannot use clipboard and upstream diagnostics are not returned", async () => {
  let active = false;
  let calls = 0;
  const service = new ScreenService({ bot: { findUnique: async () => ({ id: "bot", status: active ? "active" : "archived", defaultDirectory: "/workspace" }) } } as unknown as PrismaClient,
    "/data", "localhost", async () => { calls++; return new Response("private clipboard contents", { status: 500 }); });
  await expect(Effect.runPromise(service.clipboard("bot", { action: "copy" }))).rejects.toThrow("Active bot not found");
  expect(calls).toBe(0);
  active = true;
  await expect(Effect.runPromise(service.clipboard("bot", { action: "cut" }))).rejects.toThrow("The computer clipboard operation failed");
});

test("clipboard rejects missing text, unsupported actions, and oversized text", () => {
  const decode = Schema.decodeUnknownSync(ScreenClipboardInput);
  for (const value of [{ action: "paste" }, { action: "read" }, { action: "paste", text: "a".repeat(1_000_001) }]) {
    expect(() => decode(value)).toThrow();
  }
});
