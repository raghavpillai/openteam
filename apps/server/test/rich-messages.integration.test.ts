import { expect } from "bun:test";
import { Effect } from "effect";
import type { UserFormReceipt } from "@openteam/contracts";
import { RichMessageService } from "../src/services/rich-message-service";
import { dbIt } from "./harness";

dbIt("form response is value-free, durable, replayable until acknowledged, and idempotent", async ({ db, messaging, bot, run, context }) => {
  const secret = "SYNTHETIC_FORM_SECRET_NOT_FOR_DB", email = "private-fixture@example.com";
  let hostCalls = 0;
  const screens = { userFormAction: async (_bot: string, formId: string, action: string, input: { form?: unknown; values?: unknown }) => {
    if (action === "prepare") return input.form;
    hostCalls++;
    expect(input.values).toEqual({ email, password: secret });
    return { formId, status: "submitted", fields: [{ id: "email", status: "filled" }, { id: "password", status: "filled" }], submitAttempted: false, submitSucceeded: false } satisfies UserFormReceipt;
  } };
  const service = new RichMessageService(db, messaging, {} as never, screens as never);
  const owner = await bot("Form test");
  const home = await db.contextSession.create({ data: { botId: owner.id, scope: "home", scopeId: owner.conversationId } });
  const trigger = await db.message.create({ data: { botId: owner.id, conversationId: owner.conversationId, role: "user", content: "Sign in to the fixture", status: "completed", clientId: "form-fixture" } });
  const turn = await run(owner, { userMessageId: trigger.id });
  const field = (id: string, type: string) => ({ id, label: id, type, target: { kind: "selector", value: `#${id}` } });
  const created = await service.createUserForm(context(owner, { runId: turn.id, callId: "form-test" }), { title: "Sign in", instruction: "Use the fixture", domain: "example.com", fields: [field("email", "email"), field("password", "password")] }) as { sent: boolean; message_id: string };
  expect(created.sent).toBe(true);
  expect((await Effect.runPromise(service.submitUserForm(created.message_id, { action: "submit", values: { email, password: secret } }))).accepted).toBe(true);
  expect((await Effect.runPromise(service.submitUserForm(created.message_id, { action: "submit", values: { email: "changed", password: "changed" } }))).accepted).toBe(false);
  expect(hostCalls).toBe(1);
  const before = await messaging.platformPrompt(owner.id, home.id);
  expect(before.ambientContext).toContain("email: FILLED");
  expect((await messaging.platformPrompt(owner.id, home.id)).ambientContext).toContain("email: FILLED");
  await messaging.acknowledgePlatformPrompt(owner.id, home.id, before);
  expect((await messaging.platformPrompt(owner.id, home.id)).ambientContext ?? "").not.toContain("email: FILLED");
  const stored = await Promise.all([db.channelMessage.findMany({ where: { channelId: owner.channelId! } }), db.inboxEvent.findMany({ where: { botId: owner.id } }), db.message.findMany({ where: { conversationId: owner.conversationId } }), db.event.findMany({ where: { entityId: created.message_id } })]);
  const serialized = JSON.stringify(stored, (_key, value) => typeof value === "bigint" ? String(value) : value);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(email);
  expect(await db.inboxEvent.count({ where: { botId: owner.id, type: "form.response" } })).toBe(1);
});

dbIt("widget races settle once, duplicates return the winner, dismissal settles without waking, archived cards reject", async ({ db, messaging, bot }) => {
  const service = new RichMessageService(db, messaging, {} as never, {} as never);
  const owner = await bot("Widget fixture"), channelId = owner.channelId!;
  const widget = { prompt: "Choose a route", options: [{ label: "Alpha", value: "alpha" }, { label: "Beta", value: "beta" }], allowCustom: false };
  const create = () => db.channelMessage.create({ data: { channelId, sender: "agent", senderBotId: owner.id, content: widget.prompt, metadata: { type: "widget", widget } } });
  const respond = (id: string, value: string) => Effect.runPromise(service.respondToWidget(id, { value, clientId: crypto.randomUUID() }));
  const dismiss = (id: string) => Effect.runPromise(service.dismissWidget(id, { clientId: crypto.randomUUID() }));
  const responses = () => db.inboxEvent.count({ where: { botId: owner.id, type: "widget.response" } });
  const first = await create();
  const results = await Promise.all(["alpha", "beta"].map(value => respond(first.id, value)));
  expect(results.filter(result => result.accepted)).toHaveLength(1);
  const winner = (results.find(result => result.accepted)!.message.metadata as any).respondedValue;
  expect(results.every(result => (result.message.metadata as any).respondedValue === winner)).toBe(true);
  expect(await responses()).toBe(1);
  expect((await dismiss(first.id)).accepted).toBe(false);
  const second = await create();
  await expect(respond(second.id, "invalid")).rejects.toThrow();
  expect((await db.channelMessage.findUniqueOrThrow({ where: { id: second.id } })).metadata).not.toHaveProperty("respondedValue");
  const dismissed = await Promise.all([1, 2].map(() => dismiss(second.id)));
  expect(dismissed.filter(result => result.accepted)).toHaveLength(1);
  expect(dismissed.every(result => (result.message.metadata as any).widgetDismissed === true)).toBe(true);
  const third = await create();
  await db.channel.update({ where: { id: channelId }, data: { archivedAt: new Date() } });
  await expect(respond(third.id, "alpha")).rejects.toThrow("Live widget not found");
  expect(await responses()).toBe(1);
});

dbIt("a computer handoff leases on start, releases on completion and resumes once; escalated forms resume once on any outcome", async ({ db, messaging, bot }) => {
  const takeovers: boolean[] = [];
  const service = new RichMessageService(db, messaging, {} as never, { takeover: (_botId: string, active: boolean) => { takeovers.push(active); return Effect.succeed({ humanTakeover: active }); } } as never);
  const owner = await bot("Handoff fixture");
  const card = (metadata: Record<string, unknown>) => db.channelMessage.create({ data: { channelId: owner.channelId!, sender: "agent", senderBotId: owner.id, content: "Finish 2FA", metadata } as never });
  const mutate = (id: string, action: "start" | "complete" | "skip" | "dismiss") => Effect.runPromise(service.mutateComputerHandoff(id, { action, clientId: crypto.randomUUID() }));
  const resumes = () => db.inboxEvent.count({ where: { botId: owner.id, type: { startsWith: "computer-handoff." } } });
  const handoff = await card({ type: "computer-handoff", computerHandoff: { reason: "Finish 2FA" } });
  expect(await mutate(handoff.id, "start")).toMatchObject({ accepted: true, runId: null, message: { metadata: { computerHandoffState: "active" } } });
  const completed = await mutate(handoff.id, "complete");
  expect(completed).toMatchObject({ accepted: true, message: { metadata: { computerHandoffState: "completed" } } });
  expect(await db.run.findUniqueOrThrow({ where: { id: completed.runId! } })).toMatchObject({ origin: "handoff_resume", channelId: owner.channelId });
  expect(await mutate(handoff.id, "dismiss")).toMatchObject({ accepted: false, runId: null });
  expect(takeovers).toEqual([true, false]);
  expect(await resumes()).toBe(1);
  for (const action of ["skip", "complete", "dismiss"] as const) {
    const form = await card({ type: "user-form", cardState: "escalated", form: { id: crypto.randomUUID(), title: "Google sign-in" } });
    expect((await mutate(form.id, action)).accepted).toBe(true);
    expect((await mutate(form.id, action)).accepted).toBe(false);
  }
  expect(takeovers).toEqual([true, false, false, false, false]);
  expect(await resumes()).toBe(4);
});
