import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "../src/model-runtime";

test("Claude Code and Anthropic have independent credentials, auth methods and models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-identities-"));
  const options = {
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    modelsStorePath: join(dir, "store.json"),
    allowModelNetwork: false,
    settingsPath: join(dir, "settings.json"),
  };
  try {
    await writeFile(
      options.authPath,
      JSON.stringify({
        "claude-code": {
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 3600000,
        },
      })
    );
    await writeFile(
      options.settingsPath,
      JSON.stringify({
        inference: { providerId: "claude-code", modelId: "claude-test", reasoning: "high" },
        unrelated: true,
      })
    );
    const runtime = await createModelRuntime(options);
    expect(JSON.parse(await readFile(options.settingsPath, "utf8"))).toEqual({
      inference: { providerId: "claude-code", modelId: "claude-test", reasoning: "high" },
      unrelated: true,
    });
    expect(Object.keys(runtime.getProvider("anthropic")!.auth)).toEqual(["apiKey"]);
    expect(Object.keys(runtime.getProvider("claude-code")!.auth)).toEqual(["oauth"]);
    expect(Object.keys(runtime.getProvider("openrouter")!.auth)).toEqual(["apiKey"]);
    expect(runtime.getModels("claude-code").length).toBeGreaterThan(0);
    expect(runtime.getModels("claude-code").every((m) => m.provider === "claude-code")).toBe(true);
    const auth = JSON.parse(await readFile(options.authPath, "utf8"));
    expect(auth.anthropic).toBeUndefined();
    expect(auth["claude-code"].access).toBe("synthetic-access");
    await runtime.login("anthropic", "api_key", {
      prompt: async () => "synthetic-api-key",
      notify() {},
    });
    expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("synthetic-api-key");
    expect((await runtime.checkAuth("claude-code"))?.type).toBe("oauth");
    await runtime.logout("anthropic");
    expect((await runtime.checkAuth("claude-code"))?.type).toBe("oauth");
    const restarted = await createModelRuntime(options);
    expect((await restarted.checkAuth("claude-code"))?.type).toBe("oauth");
    await restarted.logout("claude-code");
    const again = await createModelRuntime(options);
    expect(await again.checkAuth("claude-code")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
