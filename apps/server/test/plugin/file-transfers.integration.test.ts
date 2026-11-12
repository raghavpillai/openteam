import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { ConnectorFileTransfers } from "../../src/services/plugin/file-transfers";
import { describeUploadFileOutcome } from "@openteam/contracts/reference-formatters";
import { createHash } from "node:crypto";
import { spoolFile } from "@openteam/plugin-sdk/file-spool";
import { FileTransferProvider } from "../../src/services/plugin/file-transfer-providers";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl).each(["google-drive", "gmail"] as const)(
  "%s file transfers pin account, hash and call identity and do not replay writes after restart",
  async (pluginKey) => {
    const db = createPrismaClient(databaseUrl!);
    const botId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    let writes = 0;
    let providerFailure: Error | undefined;
    let preparationFailure: Error | undefined;
    try {
      await db.bot.create({
        data: {
          id: botId,
          name: "File fixture",
          defaultDirectory: "/workspace",
          status: "active",
          conversation: { create: {} },
        },
      });
      await db.pluginInstallation.create({
        data: {
          id: installationId,
          pluginKey,
          name: `${pluginKey} fixture`,
          version: "fixture",
          publisher: "OpenTeam",
          description: "Fixture",
          manifest: {},
          status: "installed",
        },
      });
      const connection = await db.pluginConnection.create({
        data: {
          installationId,
          connectorKey: pluginKey === "gmail" ? "gmail" : "drive",
          name: `${pluginKey} fixture`,
          transport: "stdio",
          authType: "oauth",
          status: "ready",
          configuration: {},
          credentials: {},
        },
      });
      const service = () =>
        new ConnectorFileTransfers(
          db,
          async () => {
            if (preparationFailure) throw preparationFailure;
            return "fixture-token";
          },
          () =>
            ({
              upload: async () => {
                writes++;
                if (providerFailure) throw providerFailure;
                return { id: "uploaded", name: "file.bin", sizeBytes: 3 };
              },
            }) as never
        );
      const context = { botId, runId, callId };
      const bytes = Buffer.from("abc");
      const raw = {
        tool: "UploadFile",
        input: { connection: connection.id, sourcePath: "/workspace/file.bin", destination: pluginKey === "gmail" ? { draftId: "fixture-draft" } : {} },
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: 3,
      };
      expect(await service().prepare(context, raw)).toMatchObject({
        connectionId: connection.id,
      });
      await expect(
        service().execute(context, {
          ...raw,
          bytesBase64: Buffer.from("abd").toString("base64"),
        })
      ).rejects.toThrow("changed");
      expect(writes).toBe(0);
      expect(
        await service().execute(context, {
          ...raw,
          bytesBase64: bytes.toString("base64"),
        })
      ).toMatchObject({ id: "uploaded" });
      expect(writes).toBe(1);
      expect(
        await service().execute(context, {
          ...raw,
          bytesBase64: bytes.toString("base64"),
        })
      ).toMatchObject({ id: "uploaded" });
      expect(writes).toBe(1);
      const stored = await db.connectorFileTransfer.findUniqueOrThrow({ where: { callId } });
      expect(JSON.stringify(stored)).not.toContain("bytesBase64");
      expect(JSON.stringify(stored)).not.toContain("fixture-token");
      const preparationContext = { ...context, callId: crypto.randomUUID() };
      await service().prepare(preparationContext, raw);
      preparationFailure = new Error("Private preparation diagnostic");
      const preparationResult = await service().execute(preparationContext, {
        ...raw,
        bytesBase64: bytes.toString("base64"),
      });
      expect(preparationResult).toMatchObject({ outcome: {
        kind: "unavailable",
        message: "OpenTeam could not prepare the upload before contacting the provider.",
      } });
      expect(describeUploadFileOutcome((preparationResult as any).outcome, raw.input)).toContain("Nothing was uploaded");
      expect(JSON.stringify(preparationResult)).not.toContain("Private preparation diagnostic");
      expect(writes).toBe(1);
      await expect(service().execute(preparationContext, {
        ...raw,
        bytesBase64: bytes.toString("base64"),
      })).rejects.toThrow("uncertain");
      preparationFailure = undefined;
      for (const [status,kind] of [[401,"needs_auth"],[404,"invalid_destination"],[403,"rejected"],[503,"uncertain"]] as const) {
        const failedContext={...context,callId:crypto.randomUUID()};
        await service().prepare(failedContext,raw);
        providerFailure=Object.assign(new Error("Private provider diagnostic"),{status});
        const result=await service().execute(failedContext,{...raw,bytesBase64:bytes.toString("base64")});
        expect(result).toMatchObject({outcome:{kind}});
        expect(JSON.stringify(result)).not.toContain("Private provider diagnostic");
        const before=writes;
        await expect(service().execute(failedContext,{...raw,bytesBase64:bytes.toString("base64")})).rejects.toThrow("uncertain");
        expect(writes).toBe(before);
      }
      // Two accounts of one service: the short name names both instead of calling the service unknown.
      const second = await db.pluginConnection.create({ data: {
        installationId, connectorKey: pluginKey === "gmail" ? "gmail" : "drive", name: `${pluginKey} fixture`, alias: "home", transport: "stdio", authType: "oauth", status: "ready", configuration: {}, credentials: {},
      } });
      const ambiguous = await service().prepare({ ...context, callId: crypto.randomUUID() }, { ...raw, input: { ...raw.input, connection: pluginKey } });
      expect(ambiguous).toMatchObject({ outcome: { kind: "ambiguous_connection", service: `${pluginKey} fixture` } });
      expect(describeUploadFileOutcome((ambiguous as any).outcome, { connection: pluginKey, sourcePath: "/workspace/file.bin" })).toBe(
        `${JSON.stringify(pluginKey)} matches several connected ${pluginKey} fixture accounts: ${(ambiguous as any).outcome.candidates.join(", ")}. Pass one of those identifiers as connection (GetMcpServerStatus shows which account each one is) so the right account is used. Nothing was uploaded.`
      );
      expect((ambiguous as any).outcome.candidates).toHaveLength(2);
      await db.pluginConnection.delete({where:{id:second.id}});
      await db.pluginConnection.delete({where:{id:connection.id}});
      expect(await service().prepare({ ...context, callId: crypto.randomUUID() }, raw))
        .toMatchObject({outcome:{kind:"unknown_connection",available:[]}});
      expect(writes).toBe(5);
    } finally {
      await db.connectorFileTransfer.deleteMany({ where: { botId } });
      await db.pluginInstallation.deleteMany({ where: { id: installationId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);

async function withGmailFixture(run: (fixture: {
  db: ReturnType<typeof createPrismaClient>;
  botId: string;
  runId: string;
  connectionId: string;
}) => Promise<void>) {
  const db = createPrismaClient(databaseUrl!);
  const botId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  try {
    await db.bot.create({ data: {
      id: botId, name: "Gmail transfer fixture", defaultDirectory: "/workspace",
      status: "active", conversation: { create: {} },
    } });
    await db.pluginInstallation.create({ data: {
      id: installationId, pluginKey: "gmail", name: "Gmail transfer fixture",
      version: "fixture", publisher: "OpenTeam", description: "Fixture",
      manifest: {}, status: "installed",
    } });
    const connection = await db.pluginConnection.create({ data: {
      installationId, connectorKey: "gmail", name: "Gmail transfer fixture",
      transport: "stdio", authType: "oauth", status: "ready",
      configuration: {}, credentials: {},
    } });
    await run({ db, botId, runId: crypto.randomUUID(), connectionId: connection.id });
  } finally {
    await db.connectorFileTransfer.deleteMany({ where: { botId } });
    await db.pluginInstallation.deleteMany({ where: { id: installationId } });
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
  }
}

test.skipIf(!databaseUrl)("Gmail uploads staged PDF bytes through the real MIME provider and replays metadata only", async () => {
  await withGmailFixture(async ({ db, botId, runId, connectionId }) => {
    const bytes = Buffer.from("%PDF-1.4\nsynthetic fixture\0\xff\n%%EOF\n", "latin1");
    const staged = await spoolFile(new Response(new Uint8Array(bytes)).body!);
    const old = "To: fixture@example.test\r\nSubject: Return label\r\nContent-Type: text/plain\r\n\r\nKeep this body.\r\n";
    let rawDraft = Buffer.from(old);
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
      return Response.json({ id: "fixture-draft", message: {
        id: "fixture-message", raw: rawDraft.toString("base64url"), threadId: "fixture-thread",
      } });
    }) as typeof fetch;
    const service = new ConnectorFileTransfers(db, async () => "fixture-token",
      token => new FileTransferProvider(token, fetcher));
    const context = { botId, runId, callId: crypto.randomUUID() };
    const raw = {
      tool: "UploadFile",
      input: { connection: connectionId, sourcePath: "/workspace/label.PDF", destination: { draftId: "fixture-draft" } },
      sha256: staged.sha256, sizeBytes: staged.sizeBytes,
    };
    try {
      await service.prepare(context, raw);
      const result = await service.execute(context, raw, undefined, { upload: staged });
      expect(result).toMatchObject({ id: "fixture-draft", draftId: "fixture-draft", mimeType: "application/pdf", sizeBytes: bytes.length });
      expect(rawDraft.toString()).toContain("Keep this body.");
      expect(rawDraft.toString()).toContain("filename*=UTF-8''label.PDF");
      expect(rawDraft.toString()).toContain(bytes.toString("base64"));
      expect(methods).toEqual(["GET", "GET", "PUT"]);
      expect(await service.prepare(context, raw)).toMatchObject({ status: "completed", result });
      expect(await service.execute(context, raw, undefined, { upload: staged })).toEqual(result);
      expect(methods).toEqual(["GET", "GET", "PUT"]);
      const stored = await db.connectorFileTransfer.findUniqueOrThrow({ where: { callId: context.callId } });
      expect(stored.status).toBe("completed");
      expect(JSON.stringify(stored)).not.toContain(bytes.toString("base64"));
      expect(JSON.stringify(stored)).not.toContain("fixture-token");
    } finally {
      await staged.cleanup();
    }
  });
});

test.skipIf(!databaseUrl)("Gmail serializes writes to one draft, permits other drafts, and claims duplicate calls once", async () => {
  await withGmailFixture(async ({ db, botId, runId, connectionId }) => {
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let firstActive = false;
    let overlappingDraftWrites = false;
    const entered: string[] = [];
    const service = new ConnectorFileTransfers(db, async () => "fixture-token", () => ({
      upload: async (_provider: string, source: string, destination: Record<string, any>) => {
        entered.push(source);
        if (source === "/workspace/first.bin") {
          firstActive = true;
          firstEntered.resolve();
          await releaseFirst.promise;
          firstActive = false;
        } else if (destination.draftId === "shared-draft" && firstActive) {
          overlappingDraftWrites = true;
        }
        return { id: destination.draftId, name: source, sizeBytes: 3 };
      },
    }) as never);
    const bytes = Buffer.from("abc");
    const operations = [
      ["first", "shared-draft"], ["second", "shared-draft"], ["other", "independent-draft"],
    ].map(([name, draftId]) => ({
      context: { botId, runId, callId: crypto.randomUUID() },
      raw: {
        tool: "UploadFile", sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length, bytesBase64: bytes.toString("base64"),
        input: { connection: connectionId, sourcePath: `/workspace/${name}.bin`, destination: { draftId } },
      },
    }));
    for (const { context, raw } of operations) await service.prepare(context, raw);
    const first = service.execute(operations[0]!.context, operations[0]!.raw);
    const pending: Array<Promise<unknown>> = [first];
    try {
      await firstEntered.promise;
      const second = service.execute(operations[1]!.context, operations[1]!.raw);
      const duplicate = service.execute(operations[1]!.context, operations[1]!.raw);
      // Attach rejection handlers before either duplicate can lose its claim.
      const sameDraft = Promise.allSettled([second, duplicate]);
      pending.push(sameDraft);
      const other = service.execute(operations[2]!.context, operations[2]!.raw);
      pending.push(other);
      expect(await other).toMatchObject({ id: "independent-draft" });
      expect(firstActive).toBe(true);
      releaseFirst.resolve();
      expect(await first).toMatchObject({ id: "shared-draft" });
      const results = await sameDraft;
      expect(results.some(result => result.status === "fulfilled" && (result.value as any).id === "shared-draft")).toBe(true);
      expect(overlappingDraftWrites).toBe(false);
      expect(entered.filter(source => source === "/workspace/second.bin")).toHaveLength(1);
      expect(entered).toHaveLength(3);
      expect(await db.connectorFileTransfer.count({ where: { botId, status: "completed" } })).toBe(3);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(pending);
    }
  });
}, 10_000);
