import { expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { ScreenService, UserFormRefusal } from "../src/services/screen-service";
import { RichMessageService } from "../src/services/rich-message-service";
import { formPreparationFailureMessage } from "@openteam/contracts";

const prisma = (channelKind = "bot_dm") => ({
  bot: { findUnique: async () => ({ id: "bot", status: "active", defaultDirectory: "/workspace" }) },
  channel: { findUnique: async () => ({ kind: channelKind }) },
}) as unknown as PrismaClient;
const service = (body: unknown, calls: unknown[] = []) => new ScreenService(prisma(),
  "/data", "localhost", async (path) => { calls.push(path); return Response.json(body, { status: 400 }); });
const form = { title: "Pay", instruction: "Card", domain: "shop.example", fields: [
  { id: "cc", label: "Card number", type: "text", secret: true, target: { kind: "selector", value: "#cc" } },
] };
const context = { runId: "run", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, origin: "user" as const, callId: "call", isFork: false, replyToMessageId: null };

test("preparation returns allowlisted reasons and discards all raw driver text", async () => {
  const error = await service({ error: "form_preflight_failed", failureKinds: ["tab_missing", "SECRET-246810", "__proto__"], message: "SECRET-246810" })
    .userFormAction("bot", "form", "prepare", {}).catch(error => error);
  expect(error.code).toBe("form_preflight_failed");
  expect(error.message).toContain("No live browser tab");
  expect(error.message).not.toContain("SECRET-246810");
  expect(formPreparationFailureMessage({ error: "form_preflight_failed", failureKinds: ["__proto__", "SECRET-246810"] })).toBeUndefined();
});

test("submit failures never pass even allowlisted preparation diagnostics through", async () => {
  const error = await service({ error: "form_preflight_failed", failureKinds: ["tab_missing"], message: "SECRET-246810" })
    .userFormAction("bot", "form", "submit", {}).catch(error => error);
  expect(error.code).toBe("form_host_unavailable");
  expect(error.message).not.toContain("SECRET-246810");
  expect(error.message).not.toContain("browser tab");
});

test("a refused preflight reaches the model as the reference's status-only result, not an error", async () => {
  const screens = service({ error: "form_preflight_failed", fieldKinds: { cc: "in_unreachable_frame" }, message: "SECRET-246810" });
  const refusal = await screens.userFormAction("bot", "form", "prepare", { form }).catch(error => error);
  expect(refusal).toBeInstanceOf(UserFormRefusal);
  const result = await new RichMessageService(prisma(), {} as never, {} as never, screens).createUserForm(context, form);
  expect(result).toBe([
    'The form "Pay" was NOT shown and nothing was asked of the user: the host preflighted every targeted field against the live page and ALL of them are structurally unreachable, so the fill would fail the same way after they typed.',
    "- cc: target is inside a frame the host could not inspect (still loading or unreadable)",
    "Re-issuing this form (same targets, or fresh label/selector targets into the same unreachable frame or closed shadow root) will be refused the same way. Hand the user the screen with request_box_help so they can complete the step directly.",
  ].join("\n"));
  const offline = new RichMessageService(prisma(), {} as never, {} as never, service({ error: "form_driver_unavailable" }));
  expect(await offline.createUserForm(context, form)).toStartWith('The form "Pay" was NOT shown and nothing was asked of the user: the host could not reach the box browser at request time');
});

test("a form requested on a room turn is not preflighted and steers to the private chat", async () => {
  const calls: unknown[] = [];
  const room = new RichMessageService(prisma("group"), {} as never, {} as never,
    new ScreenService(prisma("group"), "/data", "localhost", async (path) => { calls.push(path); return Response.json({}); }));
  expect(await room.createUserForm(context, form)).toBe('The form "Pay" was NOT shown and nothing was asked of the user: this is a group-room turn, and form cards are only shown in your user\'s own 1:1 chat on the main session. Nothing is wrong with the form or its targets. If the step is for your user, ask them to continue in your 1:1 chat (pass "to":"dm" on SendToUser to reach it) and request the form from there; if it needs someone else in the room to sign in, say plainly that it cannot be done on your computer from here. Do not re-issue this form on this turn.');
  expect(calls).toEqual([]);
});
