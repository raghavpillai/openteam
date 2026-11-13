import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { describeUploadFileOutcome } from "@openteam/contracts/reference-formatters";
import { spoolFile } from "@openteam/plugin-sdk/file-spool";
import { ConnectorFileTransfers } from "../../src/services/plugin/file-transfers";
import { FileTransferProvider } from "../../src/services/plugin/file-transfer-providers";
import { dbIt, type Harness } from "../harness";

/** A bot plus one ready OAuth account of `pluginKey`; the harness removes both. */
async function account(h: Harness, pluginKey: string, connectorKey: string) {
  const bot = await h.bot("File fixture", {}, { dm: false });
  const installation = await h.db.pluginInstallation.create({ data: { pluginKey, name: `${pluginKey} fixture`, version: "fixture", publisher: "OpenTeam", description: "Fixture", manifest: {}, status: "installed" } });
  h.onClose(async () => { await h.db.connectorFileTransfer.deleteMany({ where: { botId: bot.id } }); await h.db.pluginInstallation.deleteMany({ where: { id: installation.id } }); });
  const create = (alias?: string) => h.db.pluginConnection.create({ data: {
    installationId: installation.id, connectorKey, name: `${pluginKey} fixture`, ...(alias ? { alias } : {}), transport: "stdio", authType: "oauth", status: "ready", configuration: {}, credentials: {},
  } });
  return { botId: bot.id, connection: await create(), addAccount: create };
}

dbIt("file transfers pin account, hash and call identity and do not replay writes after restart", async h => {
  const pluginKey = "google-drive";
  const { botId, connection, addAccount } = await account(h, pluginKey, "drive");
  let writes = 0, providerFailure: Error | undefined, preparationFailure: Error | undefined;
  const service = () => new ConnectorFileTransfers(h.db, async () => {
    if (preparationFailure) throw preparationFailure;
    return "fixture-token";
  }, () => ({ upload: async () => {
    writes++;
    if (providerFailure) throw providerFailure;
    return { id: "uploaded", name: "file.bin", sizeBytes: 3 };
  } }) as never);
  const context = { botId, runId: crypto.randomUUID(), callId: crypto.randomUUID() };
  const bytes = Buffer.from("abc"), bytesBase64 = bytes.toString("base64");
  const raw = { tool: "UploadFile", input: { connection: connection.id, sourcePath: "/workspace/file.bin", destination: {} }, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: 3 };
  const fresh = async () => { const next = { ...context, callId: crypto.randomUUID() }; await service().prepare(next, raw); return next; };

  expect(await service().prepare(context, raw)).toMatchObject({ connectionId: connection.id });
  await expect(service().execute(context, { ...raw, bytesBase64: Buffer.from("abd").toString("base64") })).rejects.toThrow("changed");
  expect(writes).toBe(0);
  for (let i = 0; i < 2; i++) expect(await service().execute(context, { ...raw, bytesBase64 })).toMatchObject({ id: "uploaded" });
  expect(writes).toBe(1);
  const stored = JSON.stringify(await h.db.connectorFileTransfer.findUniqueOrThrow({ where: { callId: context.callId } }));
  expect(stored).not.toContain("bytesBase64");
  expect(stored).not.toContain("fixture-token");

  const preparation = await fresh();
  preparationFailure = new Error("Private preparation diagnostic");
  const preparationResult = await service().execute(preparation, { ...raw, bytesBase64 }) as any;
  expect(preparationResult).toMatchObject({ outcome: { kind: "unavailable", message: "OpenTeam could not prepare the upload before contacting the provider." } });
  expect(describeUploadFileOutcome(preparationResult.outcome, raw.input)).toContain("Nothing was uploaded");
  expect(JSON.stringify(preparationResult)).not.toContain("Private preparation diagnostic");
  await expect(service().execute(preparation, { ...raw, bytesBase64 })).rejects.toThrow("uncertain");
  preparationFailure = undefined;
  expect(writes).toBe(1);
  for (const [status, kind] of [[401, "needs_auth"], [404, "invalid_destination"], [403, "rejected"], [503, "uncertain"]] as const) {
    const failed = await fresh();
    providerFailure = Object.assign(new Error("Private provider diagnostic"), { status });
    const result = await service().execute(failed, { ...raw, bytesBase64 });
    expect(result).toMatchObject({ outcome: { kind } });
    expect(JSON.stringify(result)).not.toContain("Private provider diagnostic");
    const before = writes;
    await expect(service().execute(failed, { ...raw, bytesBase64 })).rejects.toThrow("uncertain");
    expect(writes).toBe(before);
  }
  // Two accounts of one service: the short name names both instead of calling the service unknown.
  const second = await addAccount("home");
  const ambiguous = await service().prepare({ ...context, callId: crypto.randomUUID() }, { ...raw, input: { ...raw.input, connection: pluginKey } }) as any;
  expect(ambiguous).toMatchObject({ outcome: { kind: "ambiguous_connection", service: `${pluginKey} fixture` } });
  expect(ambiguous.outcome.candidates).toHaveLength(2);
  expect(describeUploadFileOutcome(ambiguous.outcome, { connection: pluginKey, sourcePath: "/workspace/file.bin" })).toBe(
    `${JSON.stringify(pluginKey)} matches several connected ${pluginKey} fixture accounts: ${ambiguous.outcome.candidates.join(", ")}. Pass one of those identifiers as connection (GetMcpServerStatus shows which account each one is) so the right account is used. Nothing was uploaded.`
  );
  await h.db.pluginConnection.deleteMany({ where: { id: { in: [second.id, connection.id] } } });
  expect(await service().prepare({ ...context, callId: crypto.randomUUID() }, raw)).toMatchObject({ outcome: { kind: "unknown_connection", available: [] } });
  expect(writes).toBe(5);
});

dbIt("Gmail uploads staged PDF bytes through the real MIME provider and replays metadata only", async h => {
  const { botId, connection } = await account(h, "gmail", "gmail");
  const bytes = Buffer.from("%PDF-1.4\nsynthetic fixture\0\xff\n%%EOF\n", "latin1");
  const staged = await spoolFile(new Response(new Uint8Array(bytes)).body!);
  h.onClose(() => staged.cleanup());
  let rawDraft = Buffer.from("To: fixture@example.test\r\nSubject: Return label\r\nContent-Type: text/plain\r\n\r\nKeep this body.\r\n");
  const methods: string[] = [];
  const fetcher = (async (url: any, init: RequestInit = {}) => {
    expect(String(url)).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/fixture-draft" + (init.method === "PUT" ? "" : "?format=raw"));
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-token");
    methods.push(init.method ?? "GET");
    if (init.method === "PUT") {
      const update = JSON.parse(String(init.body));
      expect(update.message.threadId).toBe("fixture-thread");
      rawDraft = Buffer.from(update.message.raw, "base64url");
      return Response.json({ id: "fixture-draft" });
    }
    return Response.json({ id: "fixture-draft", message: { id: "fixture-message", raw: rawDraft.toString("base64url"), threadId: "fixture-thread" } });
  }) as typeof fetch;
  const service = new ConnectorFileTransfers(h.db, async () => "fixture-token", token => new FileTransferProvider(token, fetcher));
  const context = { botId, runId: crypto.randomUUID(), callId: crypto.randomUUID() };
  const raw = { tool: "UploadFile", input: { connection: connection.id, sourcePath: "/workspace/label.PDF", destination: { draftId: "fixture-draft" } }, sha256: staged.sha256, sizeBytes: staged.sizeBytes };
  await service.prepare(context, raw);
  const result = await service.execute(context, raw, undefined, { upload: staged });
  expect(result).toMatchObject({ id: "fixture-draft", draftId: "fixture-draft", mimeType: "application/pdf", sizeBytes: bytes.length });
  for (const part of ["Keep this body.", "filename*=UTF-8''label.PDF", bytes.toString("base64")]) expect(rawDraft.toString()).toContain(part);
  expect(await service.prepare(context, raw)).toMatchObject({ status: "completed", result });
  expect(await service.execute(context, raw, undefined, { upload: staged })).toEqual(result);
  expect(methods).toEqual(["GET", "GET", "PUT"]);
  const stored = await h.db.connectorFileTransfer.findUniqueOrThrow({ where: { callId: context.callId } });
  expect(stored.status).toBe("completed");
  expect(JSON.stringify(stored)).not.toContain(bytes.toString("base64"));
  expect(JSON.stringify(stored)).not.toContain("fixture-token");
});
