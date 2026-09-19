import { expect, test } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { ApiError } from "@openteam/contracts";
import { createPrismaClient } from "../../../../packages/db/src";
import { MachineService } from "../../../server/src/services/machine-service";
import { MachineRelay } from "../../../server/src/machine-relay";
import { machineChannelResponse } from "../../../server/src/machine-http";
import { MachineDirectory } from "../../../computer/src/machine-directory";
import { NativeToolExecutor } from "../../../computer/src/native-tool-executor";
import { DesktopMachineEnrollment } from "../../src/main/host/machine-enrollment";
import { loadMachineIdentity } from "../../src/main/host/machine-identity";
import { startHostBridge } from "../../src/main/host/bridge";
import { executeHostJob, terminateHostChildren } from "../../src/main/host/jobs";
import { createPermissionSettingsStore } from "../../src/main/permission-settings";

async function eventually(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("two desktops enroll, stream operations, enforce permissions, reconnect and revoke without replay", async () => {
  const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
  const root = await mkdtemp(join(tmpdir(), "enrollment-e2e-"));
  const userId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const botId = crypto.randomUUID(), channelId = crypto.randomUUID();
  const ownerToken = `owner-${crypto.randomUUID()}`, controlToken = "synthetic-control-token";
  const machines = new MachineService(db, controlToken, fetch, new MachineRelay(30, 5_000));
  const clients: DesktopMachineEnrollment[] = [], bridges: Server[] = [], machineIds: string[] = [];
  const credentials = new Map<string, string>();
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    try {
      const path = new URL(request.url).pathname.replace(/^\/api\/v0\//, "/api/");
      if (path.startsWith("/api/machines/channel/")) return await machineChannelResponse(machines, request, path, async () => ({ decision: "allow", reason: "Fixture" }));
      const authorization = request.headers.get("authorization");
      if (path === "/api/machines/enroll" && authorization === `Bearer ${ownerToken}`) {
        const result = await machines.enroll(await request.json(), sessionId);
        credentials.set(result.machineId, result.credential);
        return Response.json(result);
      }
      if (authorization !== `Bearer ${controlToken}`) return new Response(null, { status: 401 });
      if (path === "/api/internal/machines") return Response.json(await machines.list());
      if (path === "/api/internal/machines/preferred") { const url=new URL(request.url); return Response.json(await machines.preferred(url.searchParams.get("botId")!,url.searchParams.get("channelId") ?? undefined)); }
      const forward = path.match(/^\/api\/internal\/machines\/([^/]+)\/bridge(\/.*)$/);
      if (forward) { await machines.assertRoutable(forward[1]!); return await machines.relay.forward(forward[1]!, forward[2]!, request); }
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: error instanceof ApiError ? error.status : 500 });
    }
  }});
  try {
    await db.user.create({ data: { id: userId, name: "Synthetic enrollment owner", email: `${userId}@example.invalid` } });
    await db.session.create({ data: { id: sessionId, userId, token: ownerToken, expiresAt: new Date(Date.now() + 60_000) } });
    await db.bot.create({data:{id:botId,name:"Machine routing fixture",defaultDirectory:root,status:"active",conversation:{create:{}}}});
    await db.channel.create({data:{id:channelId,kind:"group",name:"Machine fixture",members:{create:{botId,ordinal:0}}}});
    const fixtures = [];
    for (const label of ["Fixture laptop", "Fixture workstation"]) {
      const directory = join(root, label.replaceAll(" ", "-"));
      const machineId = await loadMachineIdentity(join(directory, "machine-id")); machineIds.push(machineId);
      const permissions = createPermissionSettingsStore(join(directory, "permissions.json"));
      await permissions.update({ localToolPermission: "always" });
      const token = crypto.randomUUID();
      const bridge = await startHostBridge({ hostname: "127.0.0.1", port: 0, token, terminalDir: join(directory, "terminals"), permissionSettings: permissions, autoReviewMode: "enforce", machineId, machineLabel: label, reviewAction: async () => ({ decision: "allow", reason: "Synthetic fixture" }), runJob: executeHostJob, capabilities:{handle:async()=>({machineId})} as never });
      bridges.push(bridge);
      const address = bridge.address(); if (!address || typeof address === "string") throw new Error("Expected TCP bridge");
      const client = new DesktopMachineEnrollment({ machineId, localToken: token, localUrl: `http://127.0.0.1:${address.port}`, getToken: async () => ownerToken, getIdentity: async () => ({ label, localToolPermission: (await permissions.read()).localToolPermission }), retryMs: 30 });
      clients.push(client); client.configure(api.url.origin);
      fixtures.push({ machineId, directory, permissions, client });
    }
    const first = fixtures[0]!, second = fixtures[1]!;
    await eventually(async () => (await machines.list()).filter(m => machineIds.includes(m.machineId) && m.connected).length === 2, "both machines online");
    const directory = new MachineDirectory(api.url.origin, controlToken, "http://127.0.0.1:1");
    const endpoint = await directory.endpoint(first.machineId), secondEndpoint = await directory.endpoint(second.machineId);
    const post = (base: string, path: string, body: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
    expect(endpoint).not.toBe(secondEndpoint);
    await expect(directory.endpoint(undefined)).rejects.toThrow("More than one");
    expect((await directory.list()).filter(m => machineIds.includes(m.machineId))).toHaveLength(2);
    expect(JSON.stringify(await machines.list())).not.toMatch(/credential|authSessionId/);
    const executor=new NativeToolExecutor({agentDir:join(root,"box"),controlToken,serverUrl:api.url.origin,hostBridgeUrl:"http://127.0.0.1:1"});
    expect(await directory.preferred(botId,channelId)).toBeUndefined();
    for (const fixture of [first,second]) {
      await db.channelMessage.create({data:{channelId,sender:"user",content:"Use this computer",metadata:{sourceMachineId:fixture.machineId}}});
      expect(await directory.preferred(botId,channelId)).toBe(fixture.machineId);
      expect(await executor.desktopCapability("FixtureIdentity",botId,{},undefined,undefined,channelId)).toEqual({machineId:fixture.machineId});
    }
    expect(await machines.preferred(crypto.randomUUID(),channelId)).toEqual({machineId:null});
    await expect(machines.enroll({machineId:crypto.randomUUID(),label:"Unauthorized",localToolPermission:"ask"},null)).rejects.toThrow("Sign in");
    expect((await fetch(`${api.url.origin}/api/v0/machines/enroll`, { method: "POST", body: "{}" })).status).toBe(401);
    const firstCredential = credentials.get(first.machineId)!;
    const deviceHeaders = (id: string, credential: string) => ({ authorization: `Bearer ${credential}`, "x-openteam-machine-id": id });
    expect((await fetch(`${api.url.origin}/api/v0/internal/machines`, { headers: deviceHeaders(first.machineId, firstCredential) })).status).toBe(401);
    expect((await fetch(`${api.url.origin}/api/v0/machines/channel/connect`, { method: "POST", headers: deviceHeaders(second.machineId, firstCredential) })).status).toBe(401);

    const marker = join(first.directory, "result.txt");
    const shell = { machineId: first.machineId, command: `printf enrolled > '${marker}'`, working_directory: first.directory };
    await first.permissions.update({ localToolPermission: "ask" });
    expect((await post(endpoint, "/v1/shell", shell)).status).toBe(409);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect((await post(endpoint, "/v1/shell", { ...shell, localApproval: "allow-once" })).status).toBe(200);
    expect(await readFile(marker, "utf8")).toBe("enrolled");
    expect((await first.permissions.read()).localToolPermission).toBe("ask");
    expect((await post(secondEndpoint, "/v1/shell", shell)).status).toBe(400);
    await first.permissions.update({ localToolPermission: "never" });
    expect((await post(endpoint, "/v1/read", { machineId: first.machineId, path: marker })).status).toBe(403);
    await first.permissions.update({ localToolPermission: "always" });
    expect((await post(endpoint, "/v1/read", { machineId: first.machineId, path: marker })).status).toBe(200);
    const started = await post(endpoint, "/v1/shell", { machineId: first.machineId, command: `printf 'ready\n'; sleep 0.3; exit 7`, working_directory: first.directory, block_until_ms: 0 });
    expect(started.status).toBe(200);
    const job = await started.json() as { shell_id: string };
    const ready = await post(endpoint, "/v1/await-shell", { machineId: first.machineId, shell_id: job.shell_id, pattern: "^ready$", block_until_ms: 1000 });
    expect(await ready.json()).toMatchObject({ pattern_matched: true });
    expect(await (await post(endpoint, "/v1/await-shell", { machineId: first.machineId, shell_id: job.shell_id, block_until_ms: 1000 })).json()).toMatchObject({ status: "completed", exit_code: 7 });
    expect((await post(secondEndpoint, "/v1/await-shell", { machineId: second.machineId, shell_id: job.shell_id, block_until_ms: 0 })).status).not.toBe(200);

    const bytes = randomBytes(10 * 1024 * 1024), file = join(first.directory, "transfer.bin");
    const prepare = async (direction: "read" | "write", path = file, size = bytes.length) => {
      const response = await post(endpoint, "/v1/file-transfer", { machineId: first.machineId, direction, path, ...(direction === "write" ? { bytes: size } : {}) });
      expect(response.status).toBe(200); return await response.json() as { transferId: string };
    };
    const upload = await prepare("write");
    const uploaded = await fetch(`${endpoint}/v1/file-transfer/${upload.transferId}`, { method: "PUT", headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/octet-stream" }, body: bytes });
    expect(uploaded.status).toBe(200); expect(await uploaded.json()).toMatchObject({ bytes: bytes.length });
    expect(digest(await readFile(file))).toBe(digest(bytes));
    const download = await prepare("read");
    const downloaded = await fetch(`${endpoint}/v1/file-transfer/${download.transferId}`, { headers: { authorization: `Bearer ${controlToken}` } });
    expect(downloaded.status).toBe(200); expect(digest(new Uint8Array(await downloaded.arrayBuffer()))).toBe(digest(bytes));
    const boxFile=join(root,"box-copy.bin"),roundTrip=join(first.directory,"round-trip.bin");
    expect((await executor.copyFile("toBox",{machineId:first.machineId,computer_path:file,box_path:boxFile},root)).details.bytes).toBe(bytes.length);
    const copiedToBox=await readFile(boxFile);
    expect(copiedToBox.length).toBe(bytes.length);
    expect(digest(copiedToBox)).toBe(digest(bytes));
    expect((await executor.copyFile("fromBox",{machineId:first.machineId,computer_path:roundTrip,box_path:boxFile},root)).details.bytes).toBe(bytes.length);
    expect(digest(await readFile(roundTrip))).toBe(digest(bytes));
    expect((await fetch(`${endpoint}/v1/file-transfer/${download.transferId}`, { headers: { authorization: `Bearer ${controlToken}` } })).status).not.toBe(200);
    const crossMachine = await prepare("read");
    expect((await fetch(`${secondEndpoint}/v1/file-transfer/${crossMachine.transferId}`, { headers: { authorization: `Bearer ${controlToken}` } })).status).not.toBe(200);
    const preserved = join(first.directory, "preserved.txt"); await writeFile(preserved, "original");
    const short = await prepare("write", preserved, 100);
    expect((await fetch(`${endpoint}/v1/file-transfer/${short.transferId}`, { method: "PUT", headers: { authorization: `Bearer ${controlToken}` }, body: "short" })).status).not.toBe(200);
    expect(await readFile(preserved, "utf8")).toBe("original");

    const actionCount = join(first.directory, "action-count");
    const inflight = post(endpoint, "/v1/shell", { machineId: first.machineId, command: `printf once >> '${actionCount}'; sleep 2`, working_directory: first.directory, block_until_ms: 10_000 });
    await eventually(async () => Bun.file(actionCount).exists(), "mutation started");
    await first.client.stop();
    expect((await inflight).status).not.toBe(200);
    expect((await machines.list()).find(m => m.machineId === first.machineId)?.connected).toBe(false);
    first.client.configure(api.url.origin);
    await eventually(async () => machines.relay.connected(first.machineId), "same machine reconnected");
    expect(await readFile(actionCount, "utf8")).toBe("once");
    expect(await db.hostMachine.count({ where: { machineId: first.machineId } })).toBe(1);
    expect((await fetch(`${api.url.origin}/api/v0/machines/channel/connect`, { method: "POST", headers: deviceHeaders(first.machineId, firstCredential) })).status).toBe(401);
    await machines.setEnabled(first.machineId, false);
    expect((await post(endpoint, "/v1/read", { machineId: first.machineId, path: marker })).status).toBe(403);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(machines.relay.connected(first.machineId)).toBe(false);
    expect((await db.hostMachine.findUnique({ where: { machineId: first.machineId } }))?.enabled).toBe(false);
    await machines.setEnabled(first.machineId, true);
    await eventually(async () => machines.relay.connected(first.machineId), "enabled machine reconnects");
    await db.session.update({ where: { id: sessionId }, data: { expiresAt: new Date(0) } });
    expect((await post(endpoint, "/v1/read", { machineId: first.machineId, path: marker })).status).toBe(403);
    await machines.revokeSession(sessionId);
    expect((await machines.list()).filter(m => machineIds.includes(m.machineId) && m.connected)).toEqual([]);
    expect((await fetch(`${api.url.origin}/api/v0/machines/channel/connect`, { method: "POST", headers: deviceHeaders(first.machineId, credentials.get(first.machineId)!) })).status).toBe(401);
  } finally {
    await Promise.all(clients.map(client => client.stop()));
    machines.relay.close(); api.stop(true);
    await Promise.all(bridges.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    // Disconnect may leave a dispatched shell completing its private receipt.
    // Drain the real host-job executor before deleting its output directory.
    await terminateHostChildren();
    await db.hostMachine.deleteMany({ where: { machineId: { in: machineIds } } });
    await db.channel.deleteMany({where:{id:channelId}});await db.bot.deleteMany({where:{id:botId}});
    await db.user.deleteMany({ where: { id: userId } }); await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
