import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import { accountUpdateCommand, passwordResetCommand } from "../src/password";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  collectSetupConfiguration,
  detectPrivateNetworkHost,
  type SetupPrompter,
  selectionActionForKey,
  setupCommand,
  supportsInteractiveSelection,
} from "../src/setup";
import type { SetupPresentation } from "../src/ui";

class AnswerPrompter implements SetupPrompter {
  readonly prompts: string[] = [];

  constructor(private readonly answers: string[]) {}

  async question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`No test answer available for: ${prompt}`);
    return answer;
  }

  async secret(prompt: string): Promise<string> {
    return this.question(prompt);
  }

  close(): void {}
}

class SelectionPrompter extends AnswerPrompter {
  readonly selections: Array<{
    prompt: string;
    options: readonly { label: string; value: string; shortcut?: string }[];
    current: string;
  }> = [];

  constructor(
    answers: string[],
    private readonly selected: string[]
  ) {
    super(answers);
  }

  async select<Value extends string>(
    prompt: string,
    options: readonly { label: string; value: Value; shortcut?: string }[],
    current: Value
  ): Promise<Value> {
    this.selections.push({ prompt, options, current });
    const selected = this.selected.shift();
    if (selected === undefined) throw new Error(`No test selection available for: ${prompt}`);
    if (!options.some((option) => option.value === selected)) {
      throw new Error(`Invalid test selection ${selected} for: ${prompt}`);
    }
    return selected as Value;
  }
}

const silentPresentation: SetupPresentation = {
  start() {},
  stage() {},
  choices() {},
  message() {},
  summary() {},
};

class SetupRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
  readonly models = new Map<string, string[]>([
    ["openai-codex", ["gpt-5.5"]],
    ["anthropic", ["claude-sonnet-5", "claude-sonnet-4-5"]],
    ["openai", ["gpt-5.5"]],
  ]);
  failComposeValidation = false;
  failStartup = false;

  constructor(private readonly onLogin: () => void = () => undefined) {}

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (command === "docker" && args[0] === "--version") {
      return { status: 0, stdout: "Docker version 29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "info") {
      return { status: 0, stdout: "29.0.0", stderr: "" };
    }
    if (command === "docker" && args[0] === "compose" && args[1] === "version") {
      return { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" };
    }
    if (args.includes("ps") && args.includes("--services")) {
      return { status: 0, stdout: "postgres\nserver\nworker\ncomputer\n", stderr: "" };
    }
    if (this.failComposeValidation && args.includes("config")) {
      return { status: 1, stdout: "", stderr: "invalid compose" };
    }
    if (this.failStartup && args.includes("up")) {
      return { status: 1, stdout: "", stderr: "startup failed" };
    }
    const utility = args.indexOf("openteam-pi-auth");
    if (utility >= 0) {
      const action = args[utility + 1];
      if (action === "add-custom") {
        const input = JSON.parse(options?.input ?? "{}") as {
          id?: string;
          model?: string;
          createOnly?: boolean;
        };
        if (!input.id || !input.model) {
          return { status: 1, stdout: "", stderr: "invalid custom provider" };
        }
        if (input.createOnly && this.models.has(input.id)) {
          return { status: 1, stdout: "", stderr: `Custom provider ${input.id} already exists` };
        }
        this.models.set(input.id, [input.model]);
        return { status: 0, stdout: `Added ${input.id}\n`, stderr: "" };
      }
      if (action === "remove-custom") {
        this.models.delete(args[utility + 2] ?? "");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (action === "models") {
        const providerId = args[utility + 2] ?? "";
        return {
          status: 0,
          stdout: JSON.stringify(
            (this.models.get(providerId) ?? []).map((modelId) => ({ providerId, modelId }))
          ),
          stderr: "",
        };
      }
      if (action === "selection") {
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
      if (action === "login") this.onLogin();
    }
    return { status: 0, stdout: "", stderr: "" };
  }
}

const providerAction = (call: SetupRunner["calls"][number]): string | undefined => {
  const index = call.args.indexOf("openteam-pi-auth");
  return index < 0 ? undefined : call.args[index + 1];
};

const createSetupFixture = (options: { authenticated?: boolean; owner?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-cli-provider-setup-"));
  temporaryDirectories.push(directory);
  const paths = installationPaths(directory);
  const state = {
    authenticated: options.authenticated ?? false,
    inference: { providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "high" },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/internal/server-settings/inference")) {
        if (!state.authenticated) {
          return Response.json(
            { error: { message: "Inference provider is not connected" } },
            { status: 400 }
          );
        }
        state.inference = (await request.json()) as typeof state.inference;
        return Response.json(state.inference);
      }
      if (url.pathname.endsWith("/internal/server-settings")) {
        return Response.json({ inference: state.inference });
      }
      return Response.json({
        status: "ready",
        runtime: { inference: state.authenticated ? "ready" : "missing" },
      });
    },
  });
  servers.push(server);
  const environment = replaceEnvironmentValue(
    createEnvironment({ version: "1.2.3", timeZone: "UTC" }),
    "OPENTEAM_API_PORT",
    String(server.port)
  );
  writeFileAtomic(
    paths.compose,
    "name: openteam\nservices:\n  server:\n    image: example/server\n  computer:\n    image: example/computer\n"
  );
  writeFileAtomic(paths.environment, environment);
  const now = new Date().toISOString();
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.com/openteam-compose.yaml",
    installedAt: now,
    updatedAt: now,
    ownerUsername: options.owner === false ? undefined : "existing.owner",
  });
  return { paths, state, environment };
};

const temporaryDirectories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("interactive setup", () => {
  test("falls back to typed prompts in terminals without cursor controls", () => {
    expect(supportsInteractiveSelection({ TERM: "dumb" })).toBe(false);
    expect(supportsInteractiveSelection({ TERM: "xterm-256color" })).toBe(true);
    expect(supportsInteractiveSelection({})).toBe(true);
  });

  test("maps all four arrow keys, number jumps, shortcuts, Enter, and Ctrl-C", () => {
    const options = [{ shortcut: "y" }, { shortcut: "n" }, {}];

    expect(selectionActionForKey("", { name: "up" }, options)).toBe("previous");
    expect(selectionActionForKey("", { name: "left" }, options)).toBe("previous");
    expect(selectionActionForKey("", { name: "down" }, options)).toBe("next");
    expect(selectionActionForKey("", { name: "right" }, options)).toBe("next");
    expect(selectionActionForKey("", { name: "return" }, options)).toBe("confirm");
    expect(selectionActionForKey("2", { name: "2" }, options)).toBe(1);
    expect(selectionActionForKey("Y", { name: "y" }, options)).toBe(0);
    expect(selectionActionForKey("", { name: "c", ctrl: true }, options)).toBe("cancel");
    expect(selectionActionForKey("x", { name: "x" }, options)).toBeNull();
  });

  test("quick setup asks only for connection, owner credentials, and provider sign-in", async () => {
    const current = parseEnvironment(
      replaceEnvironmentValue(
        createEnvironment({ version: "1.2.3", timeZone: "UTC" }),
        "OPENTEAM_PUBLIC_HOST",
        "openteam.lan"
      )
    );
    const prompter = new AnswerPrompter([
      "private",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
      "",
      "",
      "",
    ]);

    const configuration = await collectSetupConfiguration(current, false, prompter);

    expect(configuration).toEqual({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "openteam.lan",
      publicUrl: "http://openteam.lan:8787",
      composeProfiles: "direct",
      ownerUsername: "openteam",
      ownerPassword: "correct horse battery staple",
      apiPort: "8787",
      timeZone: "UTC",
      provider: "openai-codex",
      model: "gpt-5.5",
      thinking: "high",
      workerConcurrency: "8",
      authenticate: true,
      authType: "oauth",
    });
    expect(prompter.prompts).toHaveLength(7);
  });

  test("advanced setup validates optional server settings", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new AnswerPrompter([
      "private",
      "https://openteam",
      "openteam.lan",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
      "invalid",
      "9444",
      "Mars/Olympus",
      "Europe/London",
      "bad provider",
      "anthropic",
      "bad model",
      "claude-sonnet-4-5",
      "ultra",
      "xhigh",
      "0",
      "4",
      "",
      "api-key",
      "anthropic-test-secret",
    ]);

    const configuration = await collectSetupConfiguration(current, false, prompter, {
      advanced: true,
    });

    expect(configuration).toEqual({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "openteam.lan",
      publicUrl: "http://openteam.lan:9444",
      composeProfiles: "direct",
      ownerUsername: "openteam",
      ownerPassword: "correct horse battery staple",
      apiPort: "9444",
      timeZone: "Europe/London",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "xhigh",
      workerConcurrency: "4",
      authenticate: true,
      authType: "api_key",
      apiKey: "anthropic-test-secret",
    });
  });

  test("interactive menus expose each provider and both Anthropic authentication modes", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new SelectionPrompter(
      ["", "", "anthropic-test-secret"],
      ["local", "anthropic", "yes", "api_key"]
    );

    const configuration = await collectSetupConfiguration(current, false, prompter, {
      ownerConfigured: true,
    });

    expect(configuration).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      authenticate: true,
      authType: "api_key",
      apiKey: "anthropic-test-secret",
    });
    const providerSelection = prompter.selections.find(
      (selection) => selection.prompt === "Inference provider"
    );
    expect(providerSelection?.options.map((option) => option.value)).toEqual([
      "openai-codex",
      "anthropic",
      "openai",
      "custom",
    ]);
    const authenticationSelection = prompter.selections.find(
      (selection) => selection.prompt === "Anthropic authentication"
    );
    expect(authenticationSelection?.options.map((option) => option.value)).toEqual([
      "oauth",
      "api_key",
    ]);
  });

  test("custom-provider onboarding validates every field and retries an empty password", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new AnswerPrompter([
      "local",
      "custom",
      "BAD ID",
      "acme",
      "x".repeat(101),
      "Acme AI",
      "ftp://api.example.com",
      "https://api.example.com/v1/",
      "invalid-api",
      "google-generative-ai",
      "bad model",
      "gemini-2.5-pro",
      "no",
      "yes",
      "",
      "generic-provider-password",
    ]);

    const configuration = await collectSetupConfiguration(current, false, prompter, {
      ownerConfigured: true,
    });

    expect(configuration).toMatchObject({
      provider: "acme",
      model: "gemini-2.5-pro",
      authenticate: true,
      authType: "api_key",
      apiKey: "generic-provider-password",
      customProvider: {
        id: "acme",
        name: "Acme AI",
        baseUrl: "https://api.example.com/v1",
        api: "google-generative-ai",
        model: "gemini-2.5-pro",
        reasoning: false,
      },
    });
    expect(
      prompter.prompts.filter((prompt) => prompt.includes("API key or password"))
    ).toHaveLength(2);
  });

  test("reconfiguration can keep an already-registered custom provider", async () => {
    const environment = createEnvironment({ version: "1.2.3", timeZone: "UTC" });
    const prompter = new AnswerPrompter(["local", "", "", "no"]);

    const configuration = await collectSetupConfiguration(
      parseEnvironment(environment),
      true,
      prompter,
      { ownerConfigured: true },
      "existing.owner",
      { providerId: "acme", modelId: "acme-chat", reasoning: "high" }
    );

    expect(configuration.provider).toBe("acme");
    expect(configuration.model).toBe("acme-chat");
    expect(configuration.customProvider).toBeUndefined();
    expect(configuration.authenticate).toBe(false);
    expect(prompter.prompts.some((prompt) => prompt.includes("Custom provider id"))).toBe(false);
  });

  test("fresh setup defaults to automatic public HTTPS with internal ports kept private", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new AnswerPrompter([
      "",
      "bot.example.com",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
      "",
      "",
      "no",
    ]);

    const configuration = await collectSetupConfiguration(current, false, prompter, {
      fresh: true,
    });

    expect(configuration).toMatchObject({
      accessMode: "https",
      bindHost: "127.0.0.1",
      viewerBindHost: "127.0.0.1",
      publicHost: "127.0.0.1",
      publicUrl: "https://bot.example.com",
      composeProfiles: "https",
      authenticate: false,
    });
  });

  test("reconfiguration keeps the existing owner and does not ask for a password", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new AnswerPrompter(["local", "", "", "no"]);

    const configuration = await collectSetupConfiguration(
      current,
      false,
      prompter,
      {
        ownerConfigured: true,
      },
      "existing.owner"
    );

    expect(configuration.ownerUsername).toBe("existing.owner");
    expect(configuration.ownerPassword).toBeUndefined();
    expect(prompter.prompts.some((prompt) => prompt.includes("password"))).toBe(false);
  });

  test("public HTTP requires acknowledgement and keeps screen viewers off the Internet", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new AnswerPrompter([
      "3",
      "no",
      "3",
      "yes",
      "203.0.113.9",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
      "",
      "",
      "no",
    ]);

    const configuration = await collectSetupConfiguration(current, false, prompter, {
      fresh: true,
    });

    expect(configuration).toMatchObject({
      accessMode: "http",
      bindHost: "0.0.0.0",
      viewerBindHost: "127.0.0.1",
      publicHost: "127.0.0.1",
      publicUrl: "http://203.0.113.9:8787",
      composeProfiles: "direct",
    });
  });

  test("prefers a tailnet address and ignores container bridges", () => {
    const interfaces = {
      docker0: [
        {
          address: "172.17.0.1",
          netmask: "255.255.0.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.17.0.1/16",
        },
      ],
      en0: [
        {
          address: "192.168.1.20",
          netmask: "255.255.255.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:01",
          internal: false,
          cidr: "192.168.1.20/24",
        },
      ],
      utun4: [
        {
          address: "100.100.10.5",
          netmask: "255.192.0.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:02",
          internal: false,
          cidr: "100.100.10.5/10",
        },
      ],
    };
    expect(detectPrivateNetworkHost(interfaces)).toBe("100.100.10.5");
  });

  test("persists settings privately, restarts Compose, and delegates credentials to login", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-setup-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    let authenticated = false;
    let inference = { providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "high" };
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/internal/server-settings/inference")) {
          if (!authenticated) {
            return Response.json(
              { error: { message: "Inference provider is not connected" } },
              { status: 400 }
            );
          }
          inference = (await request.json()) as typeof inference;
          return Response.json(inference);
        }
        if (url.pathname.endsWith("/internal/server-settings")) {
          return Response.json({ inference });
        }
        return Response.json({
          status: "ready",
          runtime: { inference: authenticated ? "ready" : "missing" },
        });
      },
    });
    servers.push(server);

    let original = replaceEnvironmentValue(
      createEnvironment({ version: "1.2.3", timeZone: "UTC" }),
      "OPENTEAM_API_PORT",
      String(server.port)
    );
    writeFileAtomic(
      paths.compose,
      `name: openteam\nservices:\n  server:\n    image: example/openteam-server:\${OPENTEAM_VERSION}\nvolumes:\n  openteam_workspace:\n`
    );
    writeFileAtomic(paths.environment, original);
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openteam-compose.yaml",
      installedAt: now,
      updatedAt: now,
    });

    const prompter = new AnswerPrompter([
      "5",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
      "",
      "Europe/London",
      "",
      "",
      "xhigh",
      "4",
      "yes",
      "yes",
    ]);
    const runner = new SetupRunner(() => {
      authenticated = true;
    });
    await setupCommand(paths, runner, { advanced: true }, prompter);

    const updatedContents = readFileSync(paths.environment, "utf8");
    const updated = parseEnvironment(updatedContents);
    const before = parseEnvironment(original);
    expect(updated.get("OPENTEAM_TIME_ZONE")).toBe("Europe/London");
    expect(updated.has("OPENTEAM_PI_PROVIDER")).toBe(false);
    expect(updated.has("OPENTEAM_PI_MODEL")).toBe(false);
    expect(updated.has("OPENTEAM_PI_THINKING")).toBe(false);
    expect(inference).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.5",
      reasoning: "xhigh",
    });
    expect(updated.get("OPENTEAM_WORKER_CONCURRENCY")).toBe("4");
    expect(updated.get("OPENTEAM_CONTROL_TOKEN")).toBe(before.get("OPENTEAM_CONTROL_TOKEN"));
    expect(updated.get("OPENTEAM_POSTGRES_PASSWORD")).toBe(
      before.get("OPENTEAM_POSTGRES_PASSWORD")
    );
    expect(updatedContents).not.toContain("OPENAI_API_KEY");
    if (process.platform !== "win32") expect(statSync(paths.environment).mode & 0o077).toBe(0);

    const composeCalls = runner.calls.filter(
      (call) => call.command === "docker" && call.args.includes("--project-name")
    );
    expect(composeCalls.some((call) => call.args.includes("config"))).toBe(true);
    expect(
      composeCalls.some((call) => call.args.includes("stop") && call.args.includes("caddy"))
    ).toBe(true);
    expect(composeCalls.some((call) => call.args.includes("up"))).toBe(true);
    expect(
      composeCalls.some(
        (call) => call.args.includes("openteam-pi-auth") && call.args.includes("login")
      )
    ).toBe(true);
    const ownerCall = composeCalls.find((call) => call.args.includes("owner-credentials"));
    expect(ownerCall?.args).not.toContain("correct horse battery staple");
    expect(ownerCall?.options?.input).toContain('"operation":"setup"');
    expect(authenticated).toBe(true);
  });

  test("onboards an OpenAI API key after validating the Pi model and never persists the key", async () => {
    const fixture = createSetupFixture({ authenticated: true });
    const apiKey = "openai-onboarding-secret";
    const runner = new SetupRunner(() => {
      fixture.state.authenticated = true;
    });

    await setupCommand(
      fixture.paths,
      runner,
      { presentation: silentPresentation },
      new AnswerPrompter(["local", "openai", "", "yes", apiKey, "yes"])
    );

    const actions = runner.calls.map(providerAction);
    const modelIndex = actions.indexOf("models");
    const upIndex = runner.calls.findIndex((call) => call.args.includes("up"));
    const loginIndex = actions.indexOf("login");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(upIndex).toBeGreaterThan(modelIndex);
    expect(loginIndex).toBeGreaterThan(upIndex);
    const login = runner.calls[loginIndex];
    expect(login?.args).toContain("--no-TTY");
    expect(login?.args).toContain("api_key");
    expect(login?.options?.input).toBe(`${apiKey}\n`);
    expect(runner.calls.flatMap((call) => call.args).join(" ")).not.toContain(apiKey);
    const environment = readFileSync(fixture.paths.environment, "utf8");
    expect(environment).not.toContain("OPENTEAM_PI_PROVIDER");
    expect(environment).not.toContain("OPENTEAM_PI_MODEL");
    expect(fixture.state.inference).toEqual({
      providerId: "openai",
      modelId: "gpt-5.5",
      reasoning: "high",
    });
    expect(environment).not.toContain(apiKey);
  });

  test("onboards an Anthropic subscription through OAuth", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner(() => {
      fixture.state.authenticated = true;
    });

    await setupCommand(
      fixture.paths,
      runner,
      { presentation: silentPresentation },
      new AnswerPrompter(["local", "anthropic", "", "yes", "oauth", "yes"])
    );

    const login = runner.calls.find((call) => providerAction(call) === "login");
    expect(login?.args.slice(-3)).toEqual(["login", "anthropic", "oauth"]);
    expect(login?.args).not.toContain("--no-TTY");
    expect(login?.options?.inherit).toBe(true);
    const environment = readFileSync(fixture.paths.environment, "utf8");
    expect(environment).not.toContain("OPENTEAM_PI_PROVIDER");
    expect(environment).not.toContain("OPENTEAM_PI_MODEL");
    expect(fixture.state.inference).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
      reasoning: "high",
    });
  });

  test("onboards an Anthropic API key over stdin", async () => {
    const fixture = createSetupFixture();
    const apiKey = "anthropic-onboarding-secret";
    const runner = new SetupRunner(() => {
      fixture.state.authenticated = true;
    });

    await setupCommand(
      fixture.paths,
      runner,
      { presentation: silentPresentation },
      new AnswerPrompter(["local", "anthropic", "", "yes", "api-key", apiKey, "yes"])
    );

    const login = runner.calls.find((call) => providerAction(call) === "login");
    expect(login?.args.slice(-3)).toEqual(["login", "anthropic", "api_key"]);
    expect(login?.args).toContain("--no-TTY");
    expect(login?.options?.input).toBe(`${apiKey}\n`);
    expect(runner.calls.flatMap((call) => call.args).join(" ")).not.toContain(apiKey);
    expect(readFileSync(fixture.paths.environment, "utf8")).not.toContain(apiKey);
  });

  test("registers a generic provider before startup and sends its password only to login stdin", async () => {
    const fixture = createSetupFixture();
    const password = "generic-onboarding-secret";
    const runner = new SetupRunner(() => {
      fixture.state.authenticated = true;
    });

    await setupCommand(
      fixture.paths,
      runner,
      { presentation: silentPresentation },
      new AnswerPrompter([
        "local",
        "custom",
        "acme",
        "Acme AI",
        "https://api.example.com/v1/",
        "openai-responses",
        "acme-chat",
        "yes",
        "yes",
        password,
        "yes",
      ])
    );

    const actions = runner.calls.map(providerAction);
    const addIndex = actions.indexOf("add-custom");
    const modelIndex = actions.indexOf("models");
    const upIndex = runner.calls.findIndex((call) => call.args.includes("up"));
    const loginIndex = actions.indexOf("login");
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(modelIndex).toBeGreaterThan(addIndex);
    expect(upIndex).toBeGreaterThan(modelIndex);
    expect(loginIndex).toBeGreaterThan(upIndex);
    const registration = JSON.parse(runner.calls[addIndex]?.options?.input ?? "{}") as Record<
      string,
      unknown
    >;
    expect(registration).toEqual({
      id: "acme",
      name: "Acme AI",
      baseUrl: "https://api.example.com/v1",
      api: "openai-responses",
      model: "acme-chat",
      reasoning: true,
      createOnly: true,
    });
    expect(JSON.stringify(registration)).not.toContain(password);
    expect(runner.calls[loginIndex]?.options?.input).toBe(`${password}\n`);
    expect(runner.calls.flatMap((call) => call.args).join(" ")).not.toContain(password);
    const environment = readFileSync(fixture.paths.environment, "utf8");
    expect(environment).not.toContain("OPENTEAM_PI_PROVIDER");
    expect(environment).not.toContain("OPENTEAM_PI_MODEL");
    expect(fixture.state.inference).toEqual({
      providerId: "acme",
      modelId: "acme-chat",
      reasoning: "high",
    });
    expect(environment).not.toContain(password);
  });

  test("rejects an unavailable model before changing configuration or starting services", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        new AnswerPrompter(["local", "openai", "not-a-real-model", "no", "yes"])
      )
    ).rejects.toThrow("openteam model list openai");

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
    expect(runner.calls.some((call) => providerAction(call) === "login")).toBe(false);
  });

  test("does not overwrite an existing custom provider during onboarding", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();
    runner.models.set("acme", ["existing-model"]);

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        new AnswerPrompter([
          "local",
          "custom",
          "acme",
          "Acme Replacement",
          "https://replacement.example.com",
          "openai-completions",
          "replacement-model",
          "no",
          "no",
          "yes",
        ])
      )
    ).rejects.toThrow("already exists");

    expect(runner.models.get("acme")).toEqual(["existing-model"]);
    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.calls.some((call) => providerAction(call) === "remove-custom")).toBe(false);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
  });

  test("removes a newly registered provider and restores env when Compose rejects it", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();
    runner.failComposeValidation = true;

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        new AnswerPrompter([
          "local",
          "custom",
          "acme",
          "Acme AI",
          "https://api.example.com",
          "anthropic-messages",
          "acme-chat",
          "yes",
          "no",
          "yes",
        ])
      )
    ).rejects.toThrow("new configuration is invalid");

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.models.has("acme")).toBe(false);
    expect(runner.calls.some((call) => providerAction(call) === "remove-custom")).toBe(true);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
  });

  test("removes a newly registered provider and restores env when startup fails", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();
    runner.failStartup = true;

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        new AnswerPrompter([
          "local",
          "custom",
          "acme",
          "Acme AI",
          "https://api.example.com",
          "openai-completions",
          "acme-chat",
          "no",
          "no",
          "yes",
        ])
      )
    ).rejects.toThrow("previous configuration was restored");

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.models.has("acme")).toBe(false);
    expect(runner.calls.some((call) => providerAction(call) === "remove-custom")).toBe(true);
    expect(runner.calls.filter((call) => call.args.includes("up"))).toHaveLength(2);
  });

  test("reports authentication readiness failure without leaking the submitted API key", async () => {
    const fixture = createSetupFixture();
    const apiKey = "failed-auth-secret";
    const runner = new SetupRunner();

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        new AnswerPrompter(["local", "openai", "", "yes", apiKey, "yes"])
      )
    ).rejects.toThrow("openteam provider login openai");

    const login = runner.calls.find((call) => providerAction(call) === "login");
    expect(login?.options?.input).toBe(`${apiKey}\n`);
    expect(runner.calls.flatMap((call) => call.args).join(" ")).not.toContain(apiKey);
    expect(readFileSync(fixture.paths.environment, "utf8")).not.toContain(apiKey);
  });

  test("cancels setup before provider validation without changing anything", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();

    await setupCommand(
      fixture.paths,
      runner,
      { presentation: silentPresentation },
      new AnswerPrompter(["local", "", "", "no", "no"])
    );

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.calls.some((call) => providerAction(call))).toBe(false);
    expect(runner.calls.some((call) => call.args.includes("up"))).toBe(false);
  });

  test("password reset passes the confirmed secret over stdin and never command arguments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-password-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(
      paths.compose,
      "name: openteam\nservices:\n  server:\n    image: example/server\n"
    );
    writeFileAtomic(paths.environment, createEnvironment({ version: "1.2.3" }));
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openteam-compose.yaml",
      installedAt: now,
      updatedAt: now,
      ownerUsername: "openteam",
    });
    const runner = new SetupRunner(() => undefined);
    await passwordResetCommand(
      paths,
      runner,
      new AnswerPrompter(["new correct horse battery", "new correct horse battery"])
    );
    const call = runner.calls.find((candidate) => candidate.args.includes("owner-credentials"));
    expect(call?.args.join(" ")).not.toContain("new correct horse battery");
    expect(call?.options?.input).toBe(
      JSON.stringify({ operation: "update", password: "new correct horse battery" })
    );
  });

  test("account update can change the username alone or both credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-account-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(
      paths.compose,
      "name: openteam\nservices:\n  server:\n    image: example/server\n"
    );
    writeFileAtomic(paths.environment, createEnvironment({ version: "1.2.3" }));
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openteam-compose.yaml",
      installedAt: now,
      updatedAt: now,
      ownerUsername: "openteam",
    });

    const usernameRunner = new SetupRunner(() => undefined);
    await accountUpdateCommand(paths, usernameRunner, {
      username: "Renamed.Owner",
      password: false,
    });
    const usernameCall = usernameRunner.calls.find((candidate) =>
      candidate.args.includes("owner-credentials")
    );
    expect(usernameCall?.options?.input).toBe(
      JSON.stringify({ operation: "update", username: "renamed.owner" })
    );
    expect(readManifest(paths)?.ownerUsername).toBe("renamed.owner");

    const bothRunner = new SetupRunner(() => undefined);
    await accountUpdateCommand(
      paths,
      bothRunner,
      { username: "Final.Owner", password: true },
      new AnswerPrompter(["another correct horse battery", "another correct horse battery"])
    );
    const bothCall = bothRunner.calls.find((candidate) =>
      candidate.args.includes("owner-credentials")
    );
    expect(bothCall?.args.join(" ")).not.toContain("another correct horse battery");
    expect(bothCall?.options?.input).toBe(
      JSON.stringify({
        operation: "update",
        username: "final.owner",
        password: "another correct horse battery",
      })
    );
    expect(readManifest(paths)?.ownerUsername).toBe("final.owner");
  });
});
