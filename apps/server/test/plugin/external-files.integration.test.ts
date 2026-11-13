import { expect } from "bun:test";
import { Effect } from "effect";
import { PluginConnectors } from "../../src/services/plugin/connectors";
import { dbIt } from "../harness";

dbIt("native Slack delivery sends staged bytes privately, binds them to the call, and cannot replay", async h => {
  const bot = await h.bot("Native delivery fixture", {}, { dm: false });
  const run = await h.run(bot);
  const installation = await h.db.pluginInstallation.create({ data: { pluginKey: "slack", name: "Fixture Slack", version: "fixture", publisher: "Fixture", description: "Fixture", manifest: {}, status: "installed" } });
  h.onClose(() => h.db.pluginInstallation.deleteMany({ where: { id: installation.id } }));
  const connection = await h.db.pluginConnection.create({ data: { installationId: installation.id, connectorKey: "slack", name: "Slack fixture", transport: "http", authType: "token", status: "ready", configuration: {}, credentials: {} } });
  const service = new PluginConnectors(h.db, {} as never, () => Effect.succeed({}), async () => ({}), undefined, async () => "fixture-token");
  const file = { assetId: "fixture", name: "binary.dat", mimeType: "application/octet-stream", bytes: Buffer.from([0, 1, 255, 9]) };
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = (async (input: unknown, init: any) => {
    writes++;
    const url = String(input);
    if (url.endsWith("files.getUploadURLExternal")) return Response.json({ ok: true, upload_url: "https://files.slack.com/fixture-upload", file_id: "F1" });
    if (url.includes("fixture-upload")) {
      // The upload URL is pre-signed: the bytes go without the account token.
      expect(Buffer.from(init.body)).toEqual(file.bytes);
      expect(init.headers?.authorization).toBeUndefined();
      return new Response("ok");
    }
    expect(JSON.parse(init.body)).toEqual({ files: [{ id: "F1", title: file.name }], channel_id: "C1", initial_comment: "Fixture attachment" });
    return Response.json({ ok: true, files: [{ id: "F1" }] });
  }) as typeof fetch;
  try {
    const request = { botId: bot.id, runId: run.id, callId: crypto.randomUUID(), address: connection.id + ":C1", content: "Fixture attachment", files: [file] };
    const result = await service.deliverConnectedChannel(request);
    expect(JSON.stringify(result)).not.toContain("fixture-token");
    expect(writes).toBe(3);
    await expect(service.deliverConnectedChannel({ ...request, files: [{ ...file, bytes: Buffer.from("abd") }] })).rejects.toThrow("changed");
    await service.deliverConnectedChannel(request);
    await service.deliverConnectedChannel(request);
    expect(writes).toBe(3);
    await h.db.pluginConnection.update({ where: { id: connection.id }, data: { status: "disconnected" } });
    await expect(service.deliverConnectedChannel({ ...request, callId: crypto.randomUUID() })).rejects.toThrow();
    expect(writes).toBe(3);
  } finally { globalThis.fetch = original; }
});
