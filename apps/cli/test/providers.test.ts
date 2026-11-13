import { describe, expect, test } from "bun:test";
import { parseEnvironment, createEnvironment } from "../src/config";
import type { RunResult } from "../src/process";
import { modelUseCommand, providerLoginCommand } from "../src/providers";
import type { RuntimeInferenceSettings } from "../src/runtime-settings";
import type { SetupPrompter } from "../src/setup";
import { FakeDocker, installStack, scratch } from "./fixtures/harness";

const s = scratch();

class ProviderRunner extends FakeDocker {
  private customProviderAdded = false;
  readonly connected = new Set(["openai-codex"]);

  protected override respond(_command: string, args: readonly string[]): RunResult | undefined {
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
            configured: this.connected.has("openai-codex"),
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
              {
                type: "api_key",
                label: "Anthropic API key",
                subscription: false,
              },
            ],
            configured: this.connected.has("anthropic"),
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
                  configured: this.connected.has("acme"),
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
    if (args.includes("login")) this.connected.add(args[args.indexOf("login") + 1]!);
    return undefined;
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

describe("provider management", () => {
  test("passes API keys over stdin and never command arguments", async () => {
    const runner = new ProviderRunner();
    await providerLoginCommand(
      installStack(s.dir("openteam-provider-test-")).paths,
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
});

class ModelRunner extends FakeDocker {
  verificationError: string | undefined;
  models = ["gpt-5.5", "gpt-5.6-sol"].map((modelId) => ({
    providerId: "openai-codex",
    modelId,
    name: modelId,
    reasoning: true,
    reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningLevel: "medium",
    input: ["text", "image"],
    contextWindow: 272000,
    maxTokens: 128000,
  }));
  protected override respond(_command: string, args: readonly string[]): RunResult | undefined {
    if (args.includes("verify") && this.verificationError) {
      return { status: 1, stdout: "", stderr: this.verificationError };
    }
    if (args.includes("catalog")) {
      return { status: 0, stdout: JSON.stringify({ models: this.models }), stderr: "" };
    }
    return undefined;
  }
}

const fixture = () => {
  const environment = createEnvironment({ version: "1.2.3" });
  const controlToken = parseEnvironment(environment).get("OPENTEAM_CONTROL_TOKEN");
  const state = {
    selected: {
      providerId: "openai-codex",
      modelId: "gpt-5.5",
      reasoning: "high",
    } as RuntimeInferenceSettings,
    reads: 0,
    writes: [] as RuntimeInferenceSettings[],
    queryProviders: [] as Array<string | null>,
    readStatus: 200,
    writeStatus: 200,
    invalidRead: false,
  };
  const server = s.serve(async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${controlToken}`) {
      return Response.json({ error: { message: "Incorrect test token" } }, { status: 401 });
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/v0/internal/server-settings") {
      state.reads++;
      state.queryProviders.push(url.searchParams.get("provider"));
      if (state.readStatus !== 200)
        return Response.json(
          { error: { message: "Settings unavailable" } },
          { status: state.readStatus }
        );
      return Response.json(state.invalidRead ? {} : { inference: state.selected });
    }
    if (
      request.method === "PATCH" &&
      url.pathname === "/api/v0/internal/server-settings/inference"
    ) {
      const input = (await request.json()) as RuntimeInferenceSettings;
      state.writes.push(input);
      if (state.writeStatus !== 200)
        return Response.json(
          { error: { message: "Model cannot be selected" } },
          { status: state.writeStatus }
        );
      state.selected = input;
      return Response.json(input);
    }
    return new Response(null, { status: 404 });
  });
  const { paths } = installStack(s.dir("openteam-model-test-"), {
    environment,
    apiPort: server.port,
  });
  return { paths, state, runner: new ModelRunner() };
};

describe("Codex model selection", () => {
  test("switches the model while preserving reasoning when --thinking is omitted", async () => {
    const { paths, runner, state } = fixture();
    await modelUseCommand(paths, runner, { providerId: "openai-codex", modelId: "gpt-5.6-sol" });
    expect(state.writes).toEqual([
      { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "high" },
    ]);
    expect(state.selected.modelId).toBe("gpt-5.6-sol");
    expect(state.queryProviders).toEqual(["openai-codex"]);
    expect(runner.calls.find((call) => call.args.includes("verify"))?.args.slice(-3)).toEqual([
      "verify",
      "openai-codex",
      "gpt-5.6-sol",
    ]);
  });

  test.each([
    "Inference provider openai-codex is not authenticated",
  ])("rejects failed verification before changing settings: %s", async (error) => {
    const { paths, runner, state } = fixture();
    runner.verificationError = error;
    await expect(
      modelUseCommand(paths, runner, { providerId: "openai-codex", modelId: "gpt-5.6-sol" })
    ).rejects.toThrow(error);
    expect(state.reads).toBe(0);
    expect(state.writes).toHaveLength(0);
    expect(state.selected.modelId).toBe("gpt-5.5");
  });
});
