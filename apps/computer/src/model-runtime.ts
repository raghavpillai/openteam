import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";

/** Product identities own their authentication, even when they share a transport. */
export async function createModelRuntime(
  options: NonNullable<Parameters<typeof ModelRuntime.create>[0]> & {
    settingsPath?: string;
  }
) {
  const runtime = await ModelRuntime.create(options);
  const anthropic = anthropicProvider();
  const legacy = options?.authPath
    ? readStoredCredential("anthropic", options.authPath)
    : undefined;
  const existingClaude = options?.authPath
    ? readStoredCredential("claude-code", options.authPath)
    : undefined;
  const claudeModels = runtime
    .getModels("anthropic")
    .map((model) => ({ ...model, provider: "claude-code" }));
  runtime.registerNativeProvider({
    ...anthropic,
    id: "claude-code",
    name: "Claude Code",
    auth: { oauth: anthropic.auth.oauth },
    getModels: () => claudeModels,
  });
  // Move an existing subscription sign-in once. Never overwrite a separately connected account.
  if (legacy?.type === "oauth") {
    if (
      existingClaude &&
      (existingClaude.type !== "oauth" || existingClaude.refresh !== legacy.refresh)
    ) {
      throw new Error(
        "Two different Claude subscription sign-ins are stored under anthropic and claude-code. Resolve the duplicate connection before upgrading; both credentials have been preserved."
      );
    }
    if (!existingClaude) {
      const claude = runtime.getProvider("claude-code")!;
      runtime.registerNativeProvider({
        ...claude,
        auth: { oauth: { ...anthropic.auth.oauth!, login: async () => legacy } },
      });
      await runtime.login("claude-code", "oauth", {
        prompt: async () => {
          throw new Error("Unexpected migration prompt");
        },
        notify: () => {},
      });
      runtime.registerNativeProvider(claude);
    }
    // The shared root settings file is the authoritative persisted model selection.
    // Finish this before removing the old credential so an interrupted migration retries.
    if (options.settingsPath) {
      let document;
      try {
        document = JSON.parse(await readFile(options.settingsPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (document?.inference?.providerId === "anthropic") {
        document.inference.providerId = "claude-code";
        const temporary = `${options.settingsPath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
          await rename(temporary, options.settingsPath);
        } finally {
          await rm(temporary, { force: true });
        }
      }
    }
    await runtime.logout("anthropic");
  }
  runtime.registerNativeProvider({
    ...anthropic,
    auth: { apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
  });
  const openrouter = openrouterProvider();
  runtime.registerNativeProvider({ ...openrouter, auth: { apiKey: openrouter.auth.apiKey } });
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
