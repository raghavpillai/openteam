import { createUtilityPluginFixture } from "./fixtures/utility-plugin";
import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = test.skipIf(!databaseUrl);

async function fixture() {
  const db = createPrismaClient(databaseUrl!);
  const service = new PluginService(db);
  const bots = await Promise.all(
    ["First", "Second"].map((name) =>
      db.bot.create({
        data: {
          name,
          status: "active",
          defaultDirectory: "/tmp",
          conversation: { create: {} },
        },
        include: { conversation: true },
      })
    )
  );
  const runs = await Promise.all(
    bots.map((bot) =>
      db.run.create({
        data: {
          botId: bot.id,
          conversationId: bot.conversation!.id,
          userMessageId: crypto.randomUUID(),
          status: "running",
        },
      })
    )
  );
  const definition = createUtilityPluginFixture(`test-utility-${crypto.randomUUID()}`);
  const draft = await Effect.runPromise(service.management.importFiles({
    "plugin.json": JSON.stringify(definition),
  }));
  await Effect.runPromise(service.management.installDraft(draft.id));
  const settings = await Effect.runPromise(service.settings());
  const installation = settings.installs.find(
    (install) => install.pluginKey === definition.key
  )!;
  const connection = installation.connections[0]!;
  await Effect.runPromise(service.connect(connection.id));
  for (const bot of bots) await Effect.runPromise(service.setGrant(connection.id, bot.id, true));
  const request = (
    index: number,
    callId: string,
    toolName = "echo",
    args: unknown = { text: "private fixture result" }
  ) => ({
    connectionId: connection.id,
    botId: bots[index]!.id,
    runId: runs[index]!.id,
    callId,
    toolName,
    arguments: args,
  });
  const cleanup = async () => {
    await service.close();
    await db.pluginInstallation.deleteMany({ where: { id: installation.id } });
    await db.bot.deleteMany({ where: { id: { in: bots.map((bot) => bot.id) } } });
    await db.pluginDraft.deleteMany({ where: { id: draft.id } });
    await db.$disconnect();
  };
  return { db, service, request, cleanup };
}

databaseTest(
  "plugin result retries cannot cross bot, run, account, or tool boundaries",
  async () => {
    const f = await fixture();
    try {
      const callId = crypto.randomUUID();
      const request = f.request(0, callId);
      expect(await f.service.invoke(request)).toEqual({ text: "private fixture result" });
      expect(await f.service.invoke(request)).toEqual({ text: "private fixture result" });
      const account = await Effect.runPromise(
        f.service.addAccount(request.connectionId, "Second account")
      );
      await Effect.runPromise(f.service.connect(account.id));
      await Effect.runPromise(f.service.setGrant(account.id, request.botId, true));
      for (const reused of [
        f.request(1, callId),
        { ...request, runId: f.request(1, callId).runId },
        { ...request, toolName: "add", arguments: { a: 1, b: 2 } },
        { ...request, connectionId: account.id },
      ]) {
        await expect(f.service.invoke(reused)).rejects.toMatchObject({
          status: 409,
          code: "plugin_call_conflict",
        });
      }
    } finally {
      await f.cleanup();
    }
  }
);

databaseTest(
  "concurrent identical plugin requests execute once and replay after completion",
  async () => {
    const f = await fixture();
    try {
      const request = f.request(0, crypto.randomUUID());
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => f.service.invoke(request))
      );
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      for (const result of results) {
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ code: "plugin_call_replayed", status: 409 });
        else expect(result.value).toEqual({ text: "private fixture result" });
      }
      expect(await f.db.pluginInvocation.count({ where: { callId: request.callId } })).toBe(1);
      expect(
        await f.db.pluginActivity.count({ where: { botId: request.botId, kind: "tool.completed" } })
      ).toBe(1);
      expect(await f.service.invoke(request)).toEqual({ text: "private fixture result" });
    } finally {
      await f.cleanup();
    }
  }
);

databaseTest("parallel plugin calls create only one outstanding approval per run", async () => {
  const f = await fixture();
  try {
    const requests = Array.from({ length: 8 }, () =>
      f.request(0, crypto.randomUUID(), "remember_note", { note: "one reviewed effect" })
    );
    const results = await Promise.allSettled(requests.map((request) => f.service.invoke(request)));
    expect(
      results.every(
        (result) =>
          result.status === "rejected" && result.reason.code === "plugin_approval_required"
      )
    ).toBe(true);
    expect(
      await f.db.approval.count({ where: { runId: requests[0]!.runId, status: "pending" } })
    ).toBe(1);
    expect(await f.db.pluginInvocation.count({ where: { runId: requests[0]!.runId } })).toBe(1);
    await expect(
      f.service.invoke(
        f.request(0, crypto.randomUUID(), "remember_note", { note: "different effect" })
      )
    ).rejects.toMatchObject({ code: "plugin_approval_pending" });
  } finally {
    await f.cleanup();
  }
});
