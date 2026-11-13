import { expect } from "bun:test";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { dbIt, type Harness } from "../harness";
import { createUtilityPluginFixture } from "./fixtures/utility-plugin";

/** Two bots with running turns and one connected utility plugin account. */
async function fixture(h: Harness) {
  const service = new PluginService(h.db);
  const definition = createUtilityPluginFixture(`test-utility-${crypto.randomUUID()}`);
  const draft = await Effect.runPromise(service.management.importFiles({ "plugin.json": JSON.stringify(definition) }));
  h.onClose(async () => {
    await service.close();
    await h.db.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
    await h.db.pluginDraft.deleteMany({ where: { id: draft.id } });
  });
  const turns: Array<{ botId: string; runId: string }> = [];
  for (const name of ["First", "Second"]) {
    const bot = await h.bot(name, {}, { dm: false });
    turns.push({ botId: bot.id, runId: (await h.run(bot)).id });
  }
  await Effect.runPromise(service.management.installDraft(draft.id));
  const connection = (await Effect.runPromise(service.settings())).installs.find(install => install.pluginKey === definition.key)!.connections[0]!;
  await Effect.runPromise(service.connect(connection.id));
  const request = (index: number, callId: string) => ({ connectionId: connection.id, ...turns[index]!, callId, toolName: "echo", arguments: { text: "private fixture result" } as unknown });
  return { service, request };
}

dbIt("plugin result retries cannot cross bot, run, account, or tool boundaries", async h => {
  const f = await fixture(h);
  const callId = crypto.randomUUID(), request = f.request(0, callId);
  expect(await f.service.invoke(request)).toEqual({ text: "private fixture result" });
  expect(await f.service.invoke(request)).toEqual({ text: "private fixture result" });
  const account = await Effect.runPromise(f.service.addAccount(request.connectionId, "Second account"));
  await Effect.runPromise(f.service.connect(account.id));
  for (const reused of [f.request(1, callId), { ...request, runId: f.request(1, callId).runId }, { ...request, toolName: "add", arguments: { a: 1, b: 2 } }, { ...request, connectionId: account.id }])
    await expect(f.service.invoke(reused)).rejects.toMatchObject({ status: 409, code: "plugin_call_conflict" });
});

dbIt("concurrent identical plugin requests execute once and replay after completion", async h => {
  const f = await fixture(h);
  const request = f.request(0, crypto.randomUUID());
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.invoke(request)));
  expect(results.some(result => result.status === "fulfilled")).toBe(true);
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "plugin_call_replayed", status: 409 });
    else expect(result.value).toEqual({ text: "private fixture result" });
  }
  expect(await h.db.pluginInvocation.count({ where: { callId: request.callId } })).toBe(1);
  expect(await h.db.pluginActivity.count({ where: { botId: request.botId, kind: "tool.completed" } })).toBe(1);
  expect(await f.service.invoke(request)).toEqual({ text: "private fixture result" });
});
