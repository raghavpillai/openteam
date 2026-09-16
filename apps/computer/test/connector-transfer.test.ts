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
  const reviews: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-control");
      const streaming=new URL(request.url).pathname.endsWith("/connector-transfer");
      const body = streaming ? JSON.parse(Buffer.from(request.headers.get("x-openteam-transfer")!,"base64url").toString()) : await request.json() as any;
      calls.push(body);
      if (body.tool === "PrepareConnectorTransfer") {
        expect(body.arguments.bytesBase64).toBeUndefined();
        return Response.json({
          connectionId: "exact-connection",
          connectionName: "Fixture Drive",
          decision: "prompt",
        });
      }
      expect(body.tool).toBe("ExecuteConnectorTransfer");
      expect(body.arguments.reviewed).toBe(true);
      expect(body.arguments.input.connection).toBe("exact-connection");
      if (body.arguments.tool === "upload_file") {
        expect(Buffer.from(await request.arrayBuffer())).toEqual(bytes);
        expect(body.arguments.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        return Response.json({ id: "file-1", name: "fixture.bin", sizeBytes: bytes.length });
      }
      return new Response(new Uint8Array(bytes),{headers:{"x-openteam-transfer-result":Buffer.from(JSON.stringify({id:"file-1",name:"download.bin",sizeBytes:bytes.length})).toString("base64url")}});
    },
  });
  const runtime = new RuntimeTools({} as never, server.url.origin, "synthetic-control", root, root);
  Object.assign(runtime, {
    requestHostApproval: async (...args: any[]) => {
      reviews.push(args);
      return "accept";
    },
  });
  const active = {
    runtimeProfile: "agent",
    botId: "bot-fixture",
    runId: "run-fixture",
    conversationId: "room-fixture",
    channelId: "room-fixture",
    cwd: root,
    pluginNamespaces: [],
    discoveredDynamicTools: new Set<string>(),
  } as any;
  const tools = runtime.customTools(active) as any[];
  const get = tools.find((tool) => tool.name === "GetDynamicTools");
  const invoke = tools.find((tool) => tool.name === "CallDynamicTool");
  try {
    for (const name of ["upload_file", "download_file"])
      await get.execute(`discover-${name}`, { namespace: "cursor", toolName: name });
    const uploaded = await invoke.execute("upload-1", {
      namespace: "cursor",
      toolName: "upload_file",
      arguments: { connection: "Fixture Drive", sourcePath },
    });
    const downloaded = await invoke.execute("download-1", {
      namespace: "cursor",
      toolName: "download_file",
      arguments: { connection: "Fixture Drive", source: { fileId: "file-1" } },
    });
    const metadata = downloaded.details;
    expect(downloaded.content[0].text).toContain("Downloaded");
    expect(await readFile(metadata.boxPath)).toEqual(bytes);
    expect(JSON.stringify([uploaded, downloaded, reviews])).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify([uploaded, downloaded])).not.toContain("synthetic-control");
    expect(reviews).toHaveLength(2);
    expect(calls).toHaveLength(4);
    await symlink("/etc", join(root, "escape"));
    await expect(
      invoke.execute("escape", {
        namespace: "cursor",
        toolName: "upload_file",
        arguments: { connection: "Fixture Drive", sourcePath: join(root, "escape/hosts") },
      })
    ).rejects.toThrow("symlink escapes");
    expect(calls).toHaveLength(4);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
