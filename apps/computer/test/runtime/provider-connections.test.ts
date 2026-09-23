import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { IdleProviderConnections } from "../../src/runtime/provider-connections";
import { ComputerRuntime } from "../../src/runtime";
import type { ActiveTurn } from "../../src/runtime/types";

test("idle expiry releases resources, but never after the next turn acquires them", async () => {
  const released: string[] = [];
  const cache = new IdleProviderConnections(20, 2, (id) => {
    released.push(id);
  });
  cache.retain("active-again");
  cache.acquire("active-again");
  cache.retain("idle");
  await Bun.sleep(50);
  expect(released).toEqual(["idle"]);
  cache.retain("active-again");
  cache.close();
  expect(released).toEqual(["idle", "active-again"]);
});

test("capacity, deletion and shutdown bound retained resources", () => {
  const released: string[] = [];
  const cache = new IdleProviderConnections(60_000, 2, (id) => {
    released.push(id);
  });
  cache.retain("oldest");
  cache.retain("recent");
  cache.retain("newest");
  expect(released).toEqual(["oldest"]);
  cache.dispose("recent");
  cache.close();
  cache.retain("finishes-after-shutdown");
  expect(released).toEqual(["oldest", "recent", "newest", "finishes-after-shutdown"]);
});

test("actual Pi session disposal can retain transport while replacing all agent listeners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-connection-"));
  const releases: string[] = [];
  const unregister = registerSessionResourceCleanup((id) => {
    releases.push(id!);
  });
  const cache = new IdleProviderConnections();
  let first: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let second: typeof first;
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const create = async () =>
      (
        await createAgentSession({
          cwd: directory,
          agentDir: directory,
          modelRuntime,
          settingsManager,
          resourceLoader,
          noTools: "builtin",
          sessionManager: SessionManager.create(directory, directory),
        })
      ).session;
    first = await create();
    let calls = 0;
    first.subscribe(() => {
      calls++;
    });
    first.dispose({ preserveProviderResources: true });
    (first as unknown as { _emit: (event: unknown) => void })._emit({ type: "agent_start" });
    expect(calls).toBe(0);
    expect(releases).not.toContain(first.sessionId);
    cache.retain(first.sessionId);
    cache.close();
    expect(releases.filter((id) => id === first!.sessionId)).toHaveLength(1);
    second = await create();
    second.dispose();
    expect(releases).toContain(second.sessionId);
  } finally {
    cache.close();
    first?.dispose();
    second?.dispose();
    unregister();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [true, "openai-codex", true],
  [false, "openai-codex", false],
  [true, "anthropic", false],
] as const)("runtime cleanup: success=%s provider=%s retains=%s", async (success, providerId, expected) => {
  const runtime = new ComputerRuntime();
  const disposed: unknown[] = [];
  const retained: string[] = [];
  const internals = runtime as unknown as {
    cleanup: (active: ActiveTurn, preserve: boolean) => Promise<void>;
    providerConnections: { retain: (id: string) => void };
  };
  internals.providerConnections.retain = (id) => {
    retained.push(id);
  };
  const active = {
    runId: "cleanup-test",
    contextSessionId: "context",
    subagentType: "browser",
    modelRef: { providerId, modelId: "test" },
    pluginAbortController: new AbortController(),
    session: {
      sessionId: "context",
      dispose: (options: unknown) => {
        disposed.push(options);
      },
    },
  } as unknown as ActiveTurn;
  await internals.cleanup(active, success);
  expect(disposed).toEqual([{ preserveProviderResources: expected }]);
  expect(retained).toEqual(expected ? ["context"] : []);
  expect(active.session).toBeNull();
});
