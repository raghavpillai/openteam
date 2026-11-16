import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("root inference settings", () => {
  test("new installations have no saved model until one is selected from a provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-root-settings-"));
    temporaryDirectories.push(root);
    const store = new AgentDataStore({} as PrismaClient, { root, workspaceRoot: root });

    await store.ensureRuntimeDirectories();
    const document = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(document.inference).toEqual({ providerId: "openai-codex", modelId: "", reasoning: "medium" });
    expect((await store.loadRootSettings()).valid).toBe(true);
    expect(await store.loadInferenceSettings({ allowUnconfigured: true })).toEqual(document.inference);
    await expect(store.loadInferenceSettings()).rejects.toThrow("Choose and save an inference model");
    const selected = { providerId: "openai-codex", modelId: "saved-choice", reasoning: "high" as const };
    await writeFile(join(root, "settings.json"), JSON.stringify({ ...document, inference: selected }));
    await store.ensureRuntimeDirectories();
    expect(await store.loadInferenceSettings()).toEqual(selected);
  });

  test("does not migrate a settings file that lacks required inference settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-root-settings-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "settings.json"), `${JSON.stringify({
      version: 1, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true,
      conciergeConsent: "unset", settingsMigrations: [], accountScopes: {},
    })}\n`);
    const store = new AgentDataStore({} as PrismaClient, { root, workspaceRoot: root });
    await store.ensureRuntimeDirectories();
    const document = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(document.inference).toBeUndefined();
    expect((await store.loadRootSettings()).valid).toBe(false);
    await expect(store.loadInferenceSettings()).rejects.toThrow("inference is required");
  });
});
