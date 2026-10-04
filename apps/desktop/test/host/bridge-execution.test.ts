import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHostBridge } from "../../src/main/host/bridge";
import { executeHostJob } from "../../src/main/host/jobs";
import { createComputerSettingsStore } from "../../src/main/computer-settings";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const bridge = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-host-bridge-"));
  roots.push(root);
  const computerSettings = createComputerSettingsStore(join(root, "permissions.json"));
  const server = await startHostBridge({
    token: "bridge-token",
    port: 0,
    terminalDir: join(root, "terminals"),
    computerSettings,
    machineId: "machine-1",
    machineLabel: "Test Mac",
    runJob: executeHostJob,
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected bridge TCP address");
  const post = (path: string, value: unknown) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    });
  return { root, computerSettings, post };
};

describe("host bridge direct execution", () => {
  test("runs shell work directly", async () => {
    const { root, post } = await bridge();
    const marker = join(root, "direct.txt");
    const response = await post("/v1/shell", {
      command: `printf direct > '${marker}'`, working_directory: root, machineId: "machine-1",
    });
    expect(response.status).toBe(200);
    expect(await readFile(marker, "utf8")).toBe("direct");
    expect((await post("/v1/shell", { command: "printf identity", machineId: "wrong" })).status).toBe(400);
  });

  test("awaits background work and retains host identity and job validation", async () => {
    const { root, post } = await bridge();
    const started = await post("/v1/shell", {
      command: `"${process.execPath}" -e "console.log('host-ready'); setTimeout(() => process.exit(3), 200)"`,
      working_directory: root, machineId: "machine-1", block_until_ms: 0,
    });
    expect(started.status).toBe(200);
    const { shell_id, output_path } = await started.json() as {shell_id:string;output_path:string};
    const ready = await post("/v1/await-shell", {shell_id,machineId:"machine-1",pattern:"^host-ready$",block_until_ms:1000});
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({pattern_matched:true,output_path});
    expect(await (await post("/v1/await-shell", {shell_id,machineId:"machine-1",block_until_ms:1000})).json()).toMatchObject({status:"completed",exit_code:3,output_path});
    expect((await post("/v1/await-shell", {shell_id,machineId:"wrong"})).status).toBe(400);
    expect((await post("/v1/await-shell", {shell_id:"../unknown",block_until_ms:0})).status).toBe(400);
  });

  test("retired review and permission endpoints do not exist", async () => {
    const { post } = await bridge();
    const response = await post("/v1/auto-review", {
      surface:"subagentLaunch",summary:"Open the page",target:"browserUse",arguments:{task:"Open the page"},
    });
    expect(response.status).toBe(404);
    expect((await post("/v1/permissions/update", {})).status).toBe(404);
  });

  test("machine labels survive removal of permission controls", async () => {
    const { computerSettings, post } = await bridge();
    await computerSettings.update({ machineLabel:"Studio Mac" });
    expect(await (await post("/v1/machines",{})).json()).toMatchObject({machines:[{machineId:"machine-1",label:"Studio Mac"}]});
  });
});
