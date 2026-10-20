import { expect, test } from "bun:test";
import { mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { RuntimeTools } from "../src/runtime/tools";

test("discovered file tools move real box bytes over the private bridge and return metadata only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openteam-file-runtime-")));
  const sourcePath = join(root, "fixture.bin");
  const bytes = Buffer.from([0, 255, 128, 12, 37, 50, 9]);
  await writeFile(sourcePath, bytes);
  const calls: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 404 });
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-control");
      const streaming=new URL(request.url).pathname.endsWith("/connector-transfer");
      const body = streaming ? JSON.parse(Buffer.from(request.headers.get("x-openteam-transfer")!,"base64url").toString()) : await request.json() as any;
      calls.push(body);
      if (body.tool === "PrepareConnectorTransfer") {
        expect(body.arguments.bytesBase64).toBeUndefined();
        return Response.json({
          connectionId: "exact-connection",
          connectionName: "Fixture Drive",
        });
      }
      expect(body.tool).toBe("ExecuteConnectorTransfer");
      expect(body.arguments).not.toHaveProperty("reviewed");
      expect(body.arguments.input.connection).toBe("exact-connection");
      if (body.arguments.tool === "UploadFile") {
        expect(Buffer.from(await request.arrayBuffer())).toEqual(bytes);
        expect(body.arguments.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        return Response.json({ id: "file-1", name: "fixture.bin", sizeBytes: bytes.length });
      }
      return new Response(new Uint8Array(bytes),{headers:{"x-openteam-transfer-result":Buffer.from(JSON.stringify({id:"file-1",name:"download.bin",sizeBytes:bytes.length})).toString("base64url")}});
    },
  });
  const runtime = new RuntimeTools({} as never, server.url.origin, "synthetic-control", root, root);
  Object.assign(runtime, {
  });
  const active = {
    runtimeProfile: "agent",
    botId: "bot-fixture",
    runId: "run-fixture",
    conversationId: "room-fixture",
    channelId: "room-fixture",
    cwd: root,
    pluginNamespaces: [
      {name:"eligible-drive",description:"Fixture",namespaceStatus:"ready",tools:[],fileTransfers:{upload:true,download:true}},
      {name:"denied-drive",description:"Fixture",namespaceStatus:"ready",tools:[],fileTransfers:{upload:false,download:false}},
    ],
    discoveredDynamicTools: new Set<string>(),
  } as any;
  const tools = runtime.customTools(active) as any[];
  const get = tools.find((tool) => tool.name === "GetDynamicTools");
  const invoke = tools.find((tool) => tool.name === "CallDynamicTool");
  try {
    for (const name of ["UploadFile", "DownloadFile"]) {
      const discovery = await get.execute(`discover-${name}`, { namespace: "cursor", toolName: name });
      expect(JSON.stringify(discovery)).toContain("eligible-drive");
      expect(JSON.stringify(discovery)).not.toContain("denied-drive");
    }
    const uploaded = await invoke.execute("upload-1", {
      namespace: "cursor",
      toolName: "UploadFile",
      arguments: { connection: "Fixture Drive", sourcePath },
    });
    const downloaded = await invoke.execute("download-1", {
      namespace: "cursor",
      toolName: "DownloadFile",
      arguments: { connection: "Fixture Drive", source: { fileId: "file-1" } },
    });
    const metadata = downloaded.details;
    expect(downloaded.content[0].text).toContain("Downloaded");
    expect(await readFile(metadata.boxPath)).toEqual(bytes);
    expect(JSON.stringify([uploaded, downloaded])).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify([uploaded, downloaded])).not.toContain("synthetic-control");
    expect(calls).toHaveLength(4);
    await symlink("/etc", join(root, "escape"));
    const refused = await invoke.execute("escape", {
        namespace: "cursor",
        toolName: "UploadFile",
        arguments: { connection: "Fixture Drive", sourcePath: join(root, "escape/hosts") },
      });
    expect(refused.content[0].text).toContain("only sends files under");
    expect(refused.details.outcome.kind).toBe("source_refused");
    expect(calls).toHaveLength(4);
    // Workers that use the parent's connectors transfer both ways; graphical and media workers cannot.
    active.runtimeProfile = "subagent";
    for (const subagentType of ["executor", "knowledgeWork"]) {
      active.subagentType = subagentType;
      active.discoveredDynamicTools = new Set<string>();
      for (const name of ["UploadFile", "DownloadFile"])
        expect(JSON.stringify(await get.execute(`${subagentType}-discover-${name}`, { namespace: "cursor", toolName: name }))).toContain("eligible-drive");
      const workerUpload = await invoke.execute(`${subagentType}-upload`, {
        namespace: "cursor",
        toolName: "UploadFile",
        arguments: { connection: "Fixture Drive", sourcePath },
      });
      expect(workerUpload.content[0].text).toContain("Uploaded");
      const workerDownload = await invoke.execute(`${subagentType}-download`, {
        namespace: "cursor",
        toolName: "DownloadFile",
        arguments: { connection: "Fixture Drive", source: { fileId: "file-1" } },
      });
      expect(workerDownload.content[0].text).toContain("Downloaded");
    }
    expect(calls).toHaveLength(12);
    for (const subagentType of ["computerUse", "videoReview", "watchVideo"]) {
      active.subagentType = subagentType;
      active.discoveredDynamicTools = new Set<string>();
      for (const name of ["UploadFile", "DownloadFile"])
        await expect(get.execute(`${subagentType}-discover-${name}`, { namespace: "cursor", toolName: name })).rejects.toThrow(`not found: cursor/${name}`);
    }
    expect(calls).toHaveLength(12);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
