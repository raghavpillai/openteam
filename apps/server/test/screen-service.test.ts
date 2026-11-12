import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { formPreparationFailureMessage, ScreenClipboardInput } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { botRoutes } from "../src/routes/bot";
import type { RouteContext } from "../src/routes/context";
import { RichMessageService } from "../src/services/rich-message-service";
import { ScreenService, screenViewerUrl, UserFormRefusal } from "../src/services/screen-service";

type Computer = (path: string, init: RequestInit) => Promise<Response>;
const prisma = (bot: () => Record<string, unknown>, channelKind = "bot_dm") => ({
  bot: { findUnique: async () => bot() },
  channel: { findUnique: async () => ({ kind: channelKind }) },
}) as unknown as PrismaClient;
const activeBot = (defaultDirectory = "/workspace") => () => ({ id: "bot", status: "active", defaultDirectory });
const screens = (computer: Computer, bot = activeBot(), channelKind?: string) =>
  new ScreenService(prisma(bot, channelKind), "/data", "localhost", computer);
const clipboardRoute = (service: ScreenService, body: unknown, signal?: AbortSignal) => {
  const request = new Request("http://localhost/api/v0/bots/bot/screen/clipboard", { method: "POST", signal, body: JSON.stringify(body) });
  return botRoutes({ app: { screenClipboard: service.clipboard }, request, url: new URL(request.url), path: "/api/bots/bot/screen/clipboard" } as unknown as RouteContext);
};

test("the viewer URL keeps the session credential out of the HTTP request target", () => {
  const parsed = new URL(screenViewerUrl("openteam.local", 6207, "A_bc-123"));
  expect(`${parsed.origin}${parsed.pathname}`).toBe("http://openteam.local:6207/openteam.html");
  expect(parsed.searchParams.get("path")).toBe("websockify");
  expect(parsed.search).not.toContain("A_bc-123");
  expect(new URLSearchParams(parsed.hash.slice(1)).get("password")).toBe("A_bc-123");
});

test("clipboard route preserves Unicode, forwards the viewer generation and cancellation to the assigned computer", async () => {
  const abort = new AbortController();
  const bodies: unknown[] = [];
  let upstreamSignal: AbortSignal | null | undefined;
  const service = screens(async (path, init) => {
    expect(path).toBe("/v1/screens/bot/clipboard");
    bodies.push(JSON.parse(String(init.body)));
    upstreamSignal = init.signal;
    return Response.json({});
  }, activeBot("/workspace/bot"));
  const response = await clipboardRoute(service, { action: "paste", text: "👋 日本語\nsecond line", shift: true }, abort.signal);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toContain("no-store");
  abort.abort();
  expect(upstreamSignal?.aborted).toBe(true);
  expect((await clipboardRoute(service, { action: "copy", controlId: "desktop", generation: 7 }))?.status).toBe(200);
  expect(bodies).toEqual([
    { cwd: "/workspace/bot", input: { action: "paste", text: "👋 日本語\nsecond line", shift: true } },
    { cwd: "/workspace/bot", input: { action: "copy" }, control: { controlId: "desktop", generation: 7 } },
  ]);
  const decode = Schema.decodeUnknownSync(ScreenClipboardInput);
  for (const value of [{ action: "paste" }, { action: "read" }, { action: "paste", text: "a".repeat(1_000_001) }])
    expect(() => decode(value)).toThrow();
});

test("screen stream passes bytes incrementally and propagates reader cancellation", async () => {
  let cancelled = false;
  let upstreamSignal: AbortSignal | undefined;
  const abort = new AbortController();
  const service = screens(async (path, init) => {
    expect(path).toBe("/v1/screens/bot/stream?cwd=%2Fworkspace");
    upstreamSignal = init.signal as AbortSignal;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled = true; } }));
  });
  const reader = (await Effect.runPromise(service.stream("bot", abort.signal))).getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
  abort.abort();
  expect(upstreamSignal?.aborted).toBe(true);
  await reader.cancel();
  expect(cancelled).toBe(true);
});

test("inactive bots cannot use the clipboard or stream, and upstream diagnostics stay private", async () => {
  let active = false;
  let calls = 0;
  const service = screens(async () => (calls++, new Response("private upstream details", { status: 500 })),
    () => ({ id: "bot", status: active ? "active" : "archived", defaultDirectory: "/workspace" }));
  await expect(Effect.runPromise(service.clipboard("bot", { action: "copy" }))).rejects.toThrow("Active bot not found");
  await expect(Effect.runPromise(service.stream("bot", new AbortController().signal))).rejects.toThrow("Active bot not found");
  expect(calls).toBe(0);
  active = true;
  for (const run of [service.clipboard("bot", { action: "cut" }), service.stream("bot", new AbortController().signal)]) {
    const error = await Effect.runPromise(run as Effect.Effect<unknown, unknown>).catch((cause: Error) => cause) as Error;
    expect(String(error?.message)).toMatch(/clipboard operation failed|Computer video is unavailable/);
    expect(String(error?.message)).not.toContain("private upstream details");
  }
});

const formFailure = (body: unknown, calls: unknown[] = [], channelKind?: string) =>
  screens(async (path) => (calls.push(path), Response.json(body, { status: 400 })), activeBot(), channelKind);
const form = { title: "Pay", instruction: "Card", domain: "shop.example", fields: [
  { id: "cc", label: "Card number", type: "text", secret: true, target: { kind: "selector", value: "#cc" } },
] };
const formContext = { runId: "run", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, origin: "user" as const, callId: "call", isFork: false, replyToMessageId: null };

test("form preflight returns only allowlisted reasons on prepare and none on submit", async () => {
  const failure = { error: "form_preflight_failed", failureKinds: ["tab_missing", "SECRET-246810", "__proto__"], message: "SECRET-246810" };
  const prepared = await formFailure(failure).userFormAction("bot", "form", "prepare", {}).catch((error) => error);
  expect(prepared.code).toBe("form_preflight_failed");
  expect(prepared.message).toContain("No live browser tab");
  expect(prepared.message).not.toContain("SECRET-246810");
  expect(formPreparationFailureMessage({ error: "form_preflight_failed", failureKinds: ["__proto__", "SECRET-246810"] })).toBeUndefined();
  const submitted = await formFailure(failure).userFormAction("bot", "form", "submit", {}).catch((error) => error);
  expect(submitted.code).toBe("form_host_unavailable");
  expect(submitted.message).not.toContain("SECRET-246810");
  expect(submitted.message).not.toContain("browser tab");
});

test("a refused preflight reaches the model as a status result, and room turns are never preflighted", async () => {
  const refused = formFailure({ error: "form_preflight_failed", fieldKinds: { cc: "in_unreachable_frame" }, message: "SECRET-246810" });
  expect(await refused.userFormAction("bot", "form", "prepare", { form }).catch((error) => error)).toBeInstanceOf(UserFormRefusal);
  const result = await new RichMessageService(prisma(activeBot()), {} as never, {} as never, refused).createUserForm(formContext, form);
  expect(result).toStartWith('The form "Pay" was NOT shown');
  expect(result).toContain("- cc: target is inside a frame");
  expect(result).not.toContain("SECRET-246810");
  const offline = new RichMessageService(prisma(activeBot()), {} as never, {} as never, formFailure({ error: "form_driver_unavailable" }));
  expect(await offline.createUserForm(formContext, form)).toStartWith('The form "Pay" was NOT shown');
  const calls: unknown[] = [];
  const room = new RichMessageService(prisma(activeBot(), "group"), {} as never, {} as never, formFailure({}, calls, "group"));
  expect(await room.createUserForm(formContext, form)).toContain("group-room turn");
  expect(calls).toEqual([]);
});
