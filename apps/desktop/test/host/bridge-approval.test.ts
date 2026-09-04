import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHostBridge } from "../../src/main/host/bridge";
import { executeHostJob } from "../../src/main/host/jobs";
import { createPermissionSettingsStore } from "../../src/main/permission-settings";

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

const bridge = async (review: "allow" | "block" = "allow") => {
  const root = await mkdtemp(join(tmpdir(), "openteam-host-bridge-"));
  roots.push(root);
  const permissionSettings = createPermissionSettingsStore(join(root, "permissions.json"));
  const server = await startHostBridge({
    token: "bridge-token",
    port: 0,
    terminalDir: join(root, "terminals"),
    permissionSettings,
    autoReviewMode: "enforce",
    machineId: "machine-1",
    machineLabel: "Test Mac",
    reviewAction: async () => ({
      decision: review,
      reason: review === "allow" ? "safe test command" : "requires confirmation",
      proposedRule: "Allow this test command",
    }),
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
  return { root, permissionSettings, post };
};

describe("host bridge durable approval protocol", () => {
  test("does not spawn before one-shot local approval and asks again afterward", async () => {
    const { root, permissionSettings, post } = await bridge();
    const marker = join(root, "allowed.txt");
    const request = {
      command: `printf allowed > '${marker}'`,
      working_directory: root,
      machineId: "machine-1",
    };

    const pending = await post("/v1/shell", request);
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      error: "approval_required",
      approval: {
        gate: "local",
        requestMethod: "openteam/localTool",
        details: {
          machineId: "machine-1",
          machineLabel: "Test Mac",
          supportsAlwaysAllow: true,
          supportsNever: true,
        },
      },
    });
    expect(await Bun.file(marker).exists()).toBe(false);

    const allowed = await post("/v1/shell", {
      ...request,
      localApproval: "allow-once",
    });
    expect(allowed.status).toBe(200);
    expect(await readFile(marker, "utf8")).toBe("allowed");
    expect((await permissionSettings.read()).localToolPermission).toBe("ask");

    expect((await post("/v1/shell", request)).status).toBe(409);
  });

  test("persists Always and Never per local machine", async () => {
    const { root, permissionSettings, post } = await bridge();
    const command = "printf persistent-approval";
    const request = {
      command,
      working_directory: root,
      machineId: "machine-1",
    };

    expect((await post("/v1/shell", { ...request, localApproval: "always" })).status).toBe(200);
    expect((await permissionSettings.read()).localToolPermission).toBe("always");
    expect((await post("/v1/shell", request)).status).toBe(200);

    const disabled = await post("/v1/permissions/update", {
      machineId: "machine-1",
      localToolPermission: "never",
    });
    expect(disabled.status).toBe(200);
    const denied = await post("/v1/shell", request);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "Local computer tools are disabled. Do not retry this action on the user's computer.",
    });
  });

  test("keeps Auto Review as a separate approval after the local gate", async () => {
    const { root, post } = await bridge("block");
    const request = {
      command: "printf reviewed",
      description: "Print reviewed output",
      working_directory: root,
      machineId: "machine-1",
      localApproval: "allow-once",
    };

    const pending = await post("/v1/shell", request);
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      error: "approval_required",
      approval: {
        gate: "auto-review",
        requestMethod: "openteam/autoReview",
        details: {
          proposedRule: "Allow this test command",
          summary: `Print reviewed output on your local computer from ${root}`,
        },
      },
    });
    expect(
      (
        await post("/v1/shell", {
          ...request,
          autoReviewApproval: "allow-once",
        })
      ).status
    ).toBe(200);
  });

  test("renders Task and browser launches through Auto Review without a local gate", async () => {
    const { post } = await bridge("block");
    const task = "Run a task on OpenTeam's computer: “Open https://example.com and stop.”";
    const request = {
      surface: "subagentLaunch",
      summary: task,
      target: "browserUse",
      arguments: {
        task,
        prompt: "Open https://example.com and stop.",
        subagent_type: "browserUse",
      },
    };

    const pending = await post("/v1/auto-review", request);
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      error: "approval_required",
      approval: {
        gate: "auto-review",
        requestMethod: "openteam/autoReview",
        details: {
          type: "autoReview",
          action: "runTask",
          toolName: "Task",
          summary: task,
          arguments: { task },
          supportsAlwaysAllow: true,
        },
      },
    });

    expect(
      (
        await post("/v1/auto-review", {
          ...request,
          autoReviewApproval: "allow-once",
        })
      ).status
    ).toBe(200);
  });

  test("lists the exact machine identifier instead of requiring the model to guess", async () => {
    const { post } = await bridge();
    const response = await post("/v1/machines", {});
    expect(await response.json()).toEqual({
      machines: [
        {
          machineId: "machine-1",
          label: "Test Mac",
          localToolPermission: "ask",
        },
      ],
    });
  });

  test("uses the saved Computer label in listings and future approval cards", async () => {
    const { permissionSettings, post } = await bridge();
    await permissionSettings.update({ machineLabel: "Studio Mac" });
    expect(await (await post("/v1/machines", {})).json()).toMatchObject({
      machines: [{ machineId: "machine-1", label: "Studio Mac" }],
    });
    const pending = await post("/v1/shell", {
      command: "printf label",
      machineId: "machine-1",
    });
    expect(await pending.json()).toMatchObject({
      approval: { details: { machineLabel: "Studio Mac" } },
    });
  });
});
