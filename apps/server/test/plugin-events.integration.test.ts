import { expect } from "bun:test";
import { PluginEventPoller } from "../src/services/plugin/events";
import { PluginInvocations } from "../src/services/plugin/invocations";
import { PluginTransport } from "../src/services/plugin/transport";
import { dbIt, type Harness } from "./harness";

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
/** An installed plugin whose manifest declares `connections`; removed when the harness closes. */
async function plugin(h: Harness, name: string, connections: unknown[]) {
  const pluginKey = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  h.onClose(() => h.db.pluginInstallation.deleteMany({ where: { pluginKey } }));
  const installation = await h.db.pluginInstallation.create({ data: { pluginKey, version: "1.0.0", name, publisher: "Test", manifest: { key: pluginKey, name, skills: [], connections } as never } });
  const connect = (data: Record<string, unknown>) => h.db.pluginConnection.create({ data: { installationId: installation.id, transport: "stdio", authType: "none", status: "ready", ...data } as never });
  return { connect };
}

dbIt("declared event polls run on their interval, force the manifest source, and save the cursor after dispatch", async h => {
  let now = new Date("2026-10-14T12:00:00Z");
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [], dispatched: unknown[] = [];
  const saved = { mailbox: "bot@example.com", uidValidity: "7", uidNext: 43 };
  let reply: unknown = text({ events: [{ id: "mail-1", source: "webhook", kind: "received", text: "Subject: Hi", channel: "bot@example.com" }], cursor: saved });
  const poller = new PluginEventPoller(h.db, async (_connection, tool, args) => { calls.push({ tool, args }); return reply; }, async event => { dispatched.push(event); }, () => now);
  const { connect } = await plugin(h, "Events", [{ key: "mail", transport: "stdio", events: { pollTool: "poll_new_mail", source: "email", intervalSeconds: 60 } }, { key: "plain", transport: "stdio" }]);
  const connection = await connect({ connectorKey: "mail", name: "Mail" });
  // Only ready connectors that declare events are polled.
  await connect({ connectorKey: "plain", name: "Plain" });
  await connect({ connectorKey: "mail", alias: "off", name: "Off", status: "needs_auth" });
  const cursor = async () => (await h.db.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } })).eventCursor;
  const advance = (ms: number) => { now = new Date(now.getTime() + ms); };

  await poller.pollDue();
  expect(calls).toEqual([{ tool: "poll_new_mail", args: { cursor: null } }]);
  expect(dispatched).toEqual([{ id: "mail-1", source: "email", kind: "received", text: "Subject: Hi", channel: "bot@example.com" }]);
  expect(await cursor()).toEqual(saved);
  advance(30_000);
  await poller.pollDue();
  expect(calls).toHaveLength(1);
  // A tool error keeps the saved cursor.
  advance(30_000);
  reply = { isError: true, content: [{ type: "text", text: "IMAP login failed" }] };
  await poller.pollDue();
  expect(calls[1]!.args).toEqual({ cursor: saved });
  expect(await cursor()).toEqual(saved);
  // A dispatch failure keeps the cursor so the same delivery IDs are retried (and deduplicated).
  advance(60_000);
  reply = text({ events: [{ id: "mail-2", kind: "received", text: "x", channel: "bot@example.com" }], cursor: { uidNext: 44 } });
  await new PluginEventPoller(h.db, async () => reply, async () => { throw new Error("database unavailable"); }, () => now).pollDue();
  expect(await cursor()).toEqual(saved);
  // Reconfiguring the account (a new runtime generation) discards an in-flight cursor.
  advance(60_000);
  await new PluginEventPoller(h.db, async () => {
    await h.db.pluginConnection.update({ where: { id: connection.id }, data: { runtimeGeneration: { increment: 1 } } });
    return text({ events: [], cursor: { uidNext: 99 } });
  }, async () => undefined, () => now).pollDue();
  expect(await cursor()).toEqual(saved);
});

dbIt("server-side callers can invoke a connector's declared host tools; Bot calls cannot", async h => {
  const executed: string[] = [];
  // The real execution path, with the Bot computer replaced by a stub.
  const transport = new PluginTransport(h.db, {} as never, "http://127.0.0.1:8787", async (_path, init) => {
    executed.push(JSON.parse(String(init?.body)).toolName);
    return Response.json({ result: { content: [{ type: "text", text: "{}" }] } });
  });
  const invocations = new PluginInvocations(h.db, callId => transport.executeInvocation(callId));
  const bot = await h.bot("Host tool fixture", {}, { dm: false });
  const run = await h.run(bot);
  const { connect } = await plugin(h, "Host", [{ key: "mail", transport: "stdio", drafts: { platform: "email", tool: "send_reviewed_email" } }, { key: "remote", transport: "http" }]);
  const stdio = await connect({ connectorKey: "mail", name: "Mail", toolSnapshot: [], configuration: { command: "bun", args: ["server.mjs"] } });
  const http = await connect({ connectorKey: "remote", name: "Remote", transport: "http", toolSnapshot: [] });
  const call = (connectionId: string, toolName: string, hostTool?: boolean) =>
    invocations.invoke({ connectionId, botId: bot.id, runId: run.id, callId: crypto.randomUUID(), toolName, arguments: { action: "send" }, hostTool });
  await expect(call(stdio.id, "send_reviewed_email")).rejects.toThrow("Plugin tool not found");
  expect(executed).toEqual([]);
  await call(stdio.id, "send_reviewed_email", true);
  expect(executed).toEqual(["send_reviewed_email"]);
  await expect(call(stdio.id, "some_hidden_tool", true)).rejects.toThrow("declares no such host tool");
  await expect(call(http.id, "send_reviewed_email", true)).rejects.toThrow("declares no such host tool");
  expect(executed).toHaveLength(1);
});
