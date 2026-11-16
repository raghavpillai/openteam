import { expect } from "bun:test";
import { Effect } from "effect";
import { dismissQuestions, lockQuestions, type ToolContext } from "@openteam/messaging";
import { RichMessageService } from "../src/services/rich-message-service";
import { ChannelService } from "../src/services/channel-service";
import { dbIt } from "./harness";

const widget = { prompt: "Which color?", options: [{ label: "Blue", value: "blue" }, { label: "Red", value: "red" }], allowCustom: true };

dbIt("questions settle durably across normal sends, publication, retries, forks and races", async (h) => {
  const rich = new RichMessageService(h.db, h.messaging, {} as never, {} as never);
  const channels = new ChannelService(h.db, h.messaging, h.dir, async () => new Response(null));
  const bot = await h.bot("Question lifecycle");
  const channelId = bot.channelId!;
  const card = (metadata = {}) => h.db.channelMessage.create({ data: { channelId, sender: "agent", senderBotId: bot.id, content: widget.prompt, metadata: { type: "widget", widget, ...metadata } } });
  const read = async (id: string) => (await h.db.channelMessage.findUniqueOrThrow({ where: { id } })).metadata as Record<string, unknown>;
  const send = (content: string, extra = {}) => Effect.runPromise(channels.sendDirectMessage(bot.conversationId, { content, clientId: crypto.randomUUID(), attachments: [], ...extra }));
  const respond = (id: string, value: string, clientId = crypto.randomUUID()) => Effect.runPromise(rich.respondToWidget(id, { value, clientId }));
  const responses = () => h.db.inboxEvent.count({ where: { botId: bot.id, type: "widget.response" } });
  /** A question is either answered or retired, never both. */
  const settledOnce = (metadata: Record<string, unknown>) => expect((typeof metadata.respondedValue === "string") !== (metadata.widgetDismissed === true)).toBe(true);

  // A user message moves past the main-chat question only; branches and draft cards are independent.
  const first = await card();
  const branch = await card({ branched: true, questionScopeId: first.id });
  const approval = await h.db.channelMessage.create({ data: { channelId, sender: "agent", senderBotId: bot.id, content: "Review only", metadata: { type: "external-draft", cardState: "pending" } } });
  const input = { content: "Blue", clientId: crypto.randomUUID(), attachments: [] };
  await Effect.runPromise(channels.sendDirectMessage(bot.conversationId, input));
  expect(await read(first.id)).toMatchObject({ widgetDismissed: true, widgetDismissalReason: "moved-on" });
  expect(await read(first.id)).not.toHaveProperty("respondedValue");
  expect(await read(branch.id)).not.toHaveProperty("widgetDismissed");
  expect(await read(approval.id)).toMatchObject({ cardState: "pending" });
  expect((await respond(first.id, "red")).accepted).toBe(false);
  expect(await responses()).toBe(0);
  expect(await h.db.event.count({ where: { entityId: first.id, topic: "channel.message.updated" } })).toBe(1);
  // A refused fork and a retried message are not newer messages.
  const later = await card();
  await expect(send("Invalid fork", { isFork: true })).rejects.toThrow("A fork needs a reply target");
  await Effect.runPromise(channels.sendDirectMessage(bot.conversationId, input));
  expect(await read(later.id)).not.toHaveProperty("widgetDismissed");
  await send("Thread answer", { replyToMessageId: first.id, isFork: true });
  expect(await read(branch.id)).toHaveProperty("widgetDismissed", true);
  expect(await read(later.id)).not.toHaveProperty("widgetDismissed");
  expect((await respond(later.id, "blue")).accepted).toBe(true);
  await send("Another topic");
  expect(await read(later.id)).toHaveProperty("respondedValue", "blue");

  // A fresh question retires an earlier pending one; a repeated tool call does not retire itself.
  const pending = await card();
  const run = await h.run(bot);
  const context: ToolContext = h.context(bot, { runId: run.id });
  const id = ((await h.messaging.sendVisible(context, { type: "widget", widget })).acknowledgement as { message_id: string }).message_id;
  expect(await read(pending.id)).toMatchObject({ widgetDismissed: true, widgetDismissalReason: "superseded" });
  await h.messaging.sendVisible(context, { type: "widget", widget });
  expect(await read(id)).not.toHaveProperty("widgetDismissed");
  await Effect.runPromise(rich.dismissWidget(id, { clientId: crypto.randomUUID() }));
  expect(await read(id)).toHaveProperty("widgetDismissalReason", "dismissed");
  expect(await responses()).toBe(1);

  // A failure after settlement rolls back both the settlement and its update event.
  const rollback = await card();
  await expect(h.db.$transaction(async tx => {
    await lockQuestions(tx, channelId);
    await dismissQuestions(tx, channelId, null, "moved-on");
    throw new Error("Injected failure after question settlement");
  })).rejects.toThrow("Injected failure");
  expect(await read(rollback.id)).not.toHaveProperty("widgetDismissed");
  expect(await h.db.event.count({ where: { entityId: rollback.id, topic: "channel.message.updated" } })).toBe(0);
  await Effect.runPromise(rich.dismissWidget(rollback.id, { clientId: crypto.randomUUID() }));

  // Racing answers, skips and moves-on settle once; a retried nonce neither re-answers nor re-sends.
  for (let attempt = 0; attempt < 2; attempt++) {
    const q = await card(), nonce = crypto.randomUUID(), responseNonce = crypto.randomUUID();
    const before = await responses();
    const results = await Promise.all([
      respond(q.id, "blue", responseNonce), respond(q.id, "blue", responseNonce),
      Effect.runPromise(rich.dismissWidget(q.id, { clientId: crypto.randomUUID() })),
      send("Move on", { clientId: nonce }), send("Move on", { clientId: nonce }),
    ]);
    const metadata = await read(q.id);
    settledOnce(metadata);
    expect(results.slice(0, 3).filter(result => (result as { accepted: boolean }).accepted)).toHaveLength(metadata.widgetDismissalReason === "moved-on" ? 0 : 1);
    expect(await h.db.channelMessage.count({ where: { channelId, clientId: nonce } })).toBe(1);
    expect(await responses()).toBe(before + (metadata.respondedValue === "blue" ? 1 : 0));
    const retried = await respond(q.id, "blue", responseNonce);
    expect(retried.accepted).toBe(false);
    expect(retried.message.metadata).toMatchObject(metadata);
  }

  // Concurrent publications keep only the later one open, and an older retry cannot retire it.
  const turn = async () => ({ ...context, runId: (await h.run(bot)).id, callId: crypto.randomUUID() });
  const publications = [await turn(), await turn()];
  const ids = (await Promise.all(publications.map(ctx => h.messaging.sendVisible(ctx, { type: "widget", widget })))).map(result => (result.acknowledgement as { message_id: string }).message_id);
  const ordered = await h.db.channelMessage.findMany({ where: { id: { in: ids } }, orderBy: { sequence: "asc" } });
  expect(await read(ordered[0]!.id)).toHaveProperty("widgetDismissed", true);
  expect(await read(ordered[1]!.id)).not.toHaveProperty("widgetDismissed");
  await h.messaging.sendVisible(publications[ids.indexOf(ordered[0]!.id)]!, { type: "widget", widget });
  expect(await read(ordered[1]!.id)).not.toHaveProperty("widgetDismissed");
  // An answer racing a newer publication settles once, and the newer one stays open.
  const [fresh, oldResponse] = await Promise.all([
    h.messaging.sendVisible(await turn(), { type: "widget", widget }),
    respond(ordered[1]!.id, "red"),
  ]);
  const freshId = (fresh.acknowledgement as { message_id: string }).message_id;
  expect(await read(freshId)).not.toHaveProperty("widgetDismissed");
  const oldMetadata = await read(ordered[1]!.id);
  expect(oldResponse.accepted).toBe(oldMetadata.respondedValue === "red");
  settledOnce(oldMetadata);
  // A question asked in a fork leaves the main-chat question alone.
  const forked = await h.messaging.sendVisible({ ...await turn(), isFork: true, replyToMessageId: first.id }, { type: "widget", widget });
  await respond((forked.acknowledgement as { message_id: string }).message_id, "blue");
  expect(await read(freshId)).not.toHaveProperty("widgetDismissed");
  expect(await read(approval.id)).toMatchObject({ cardState: "pending" });
}, 60_000);
