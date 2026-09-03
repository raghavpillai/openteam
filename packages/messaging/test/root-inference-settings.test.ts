import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@openbot/db";
import { AgentDataStore } from "../src/agent-data";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("root inference settings", () => {
  test("migrates an existing v1 root file once so environment values are only bootstrap defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-root-settings-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "settings.json"),
      `${JSON.stringify({
        version: 1,
        mcpBoxServers: [],
        autoUpdateWhenIdleOptIn: false,
        egressTunnelEnabled: false,
        webauthnProxyEnabled: true,
        conciergeConsent: "unset",
        settingsMigrations: [],
        accountScopes: {},
      })}\n`
    );
    const store = new AgentDataStore({} as PrismaClient, { root, workspaceRoot: root });

    await store.ensureRuntimeDirectories();

    const document = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(document.inference).toEqual({
      providerId: process.env.OPENBOT_PI_PROVIDER ?? "openai-codex",
      modelId: process.env.OPENBOT_PI_MODEL ?? "gpt-5.5",
      reasoning: process.env.OPENBOT_PI_THINKING ?? "high",
    });
    expect((await store.loadRootSettings()).valid).toBe(true);
  });
});
