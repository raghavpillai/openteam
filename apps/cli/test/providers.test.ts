import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/arguments";
import {
  createEnvironment,
  installationPaths,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { providerAddCommand, providerListCommand, providerLoginCommand } from "../src/providers";
import type { SetupPrompter } from "../src/setup";

class ProviderRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
  private customProviderAdded = false;

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (command === "docker" && args[0] === "compose" && args[1] === "version") {
      return { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" };
    }
    if (args.includes("selection")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          providerId: "openai-codex",
          modelId: "gpt-5.5",
          reasoning: "high",
        }),
        stderr: "",
      };
    }
    if (args.includes("providers")) {
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            id: "openai-codex",
            name: "OpenAI Codex",
            authMethods: [{ type: "oauth", label: "ChatGPT", subscription: true }],
            configured: true,
            authType: "oauth",
            authSource: "OAuth",
            models: 4,
            custom: false,
          },
          {
            id: "anthropic",
            name: "Anthropic",
            authMethods: [
              { type: "oauth", label: "Claude Pro/Max", subscription: true },
              { type: "api_key", label: "Anthropic API key", subscription: false },
            ],
            configured: false,
            authType: null,
            authSource: null,
            models: 3,
            custom: false,
          },
          ...(this.customProviderAdded
            ? [
                {
                  id: "acme",
                  name: "Acme AI",
                  authMethods: [{ type: "api_key", label: "API key", subscription: false }],
                  configured: false,
                  authType: null,
                  authSource: null,
                  models: 1,
                  custom: true,
                },
              ]
            : []),
        ]),
        stderr: "",
      };
    }
    if (args.includes("add-custom")) this.customProviderAdded = true;
    return { status: 0, stdout: "", stderr: "" };
  }
}

class SecretPrompter implements SetupPrompter {
  constructor(private readonly value: string) {}
  question(): Promise<string> {
    return Promise.resolve("");
  }
  secret(): Promise<string> {
    return Promise.resolve(this.value);
  }
  close(): void {}
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-provider-test-"));
  directories.push(directory);
  const paths = installationPaths(directory);
  writeFileAtomic(
    paths.compose,
    "name: openteam\nservices:\n  computer:\n    image: example/computer\n"
  );
  writeFileAtomic(paths.environment, createEnvironment({ version: "1.2.3" }));
  const now = new Date().toISOString();
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.test/openteam-compose.yaml",
    installedAt: now,
    updatedAt: now,
  });
  return paths;
};

describe("provider management", () => {
  test("lists Pi providers and marks the selected provider", () => {
    const runner = new ProviderRunner();
    const output: string[] = [];
    const original = console.log;
    console.log = (...values) => output.push(values.map(String).join(" "));
    try {
      providerListCommand(fixture(), runner);
    } finally {
      console.log = original;
    }
    expect(output[0]).toStartWith("* openai-codex");
    expect(output[1]).toContain("oauth, api key");
  });

  test("passes API keys over stdin and never command arguments", async () => {
    const runner = new ProviderRunner();
    await providerLoginCommand(
      fixture(),
      runner,
      { providerId: "anthropic", authType: "api_key" },
      new SecretPrompter("anthropic-test-secret")
    );
    const login = runner.calls.find(
      (call) => call.args.includes("openteam-pi-auth") && call.args.includes("login")
    );
    expect(login?.args.join(" ")).not.toContain("anthropic-test-secret");
    expect(login?.options?.input).toBe("anthropic-test-secret\n");
    expect(login?.args).toContain("--no-TTY");
  });

  test("adds a generic Pi provider before securely configuring its password", async () => {
    const runner = new ProviderRunner();
    const options = parseArguments([
      "provider",
      "add",
      "acme",
      "--name",
      "Acme AI",
      "--base-url",
      "https://ai.example.test/v1",
      "--api",
      "openai-responses",
      "--model",
      "acme-pro",
      "--reasoning",
    ]);
    await providerAddCommand(
      fixture(),
      runner,
      options,
      new SecretPrompter("generic-test-password")
    );
    const add = runner.calls.find((call) => call.args.includes("add-custom"));
    expect(JSON.parse(add?.options?.input ?? "{}")).toMatchObject({
      id: "acme",
      api: "openai-responses",
      model: "acme-pro",
      reasoning: true,
    });
    expect(add?.options?.input).not.toContain("generic-test-password");
    const login = runner.calls.find(
      (call) => call.args.includes("login") && call.args.includes("acme")
    );
    expect(login?.options?.input).toBe("generic-test-password\n");
  });
});
