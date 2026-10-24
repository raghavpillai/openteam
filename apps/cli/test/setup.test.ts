import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import { CLI_VERSION } from "../src/constants";
import { accountUpdateCommand } from "../src/password";
import {
  type CommandRunner,
  type RunOptions,
  type RunResult,
  SystemCommandRunner,
} from "../src/process";
import {
  collectSetupConfiguration,
  detectPrivateNetworkHost,
  type SetupConfiguration,
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
  next() {},
};

class SetupRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
  failComposeValidation = false;
  failStartup = false;
  failPull = false;
  /** Docker Compose exits 130 when the user's Ctrl-C reaches it. */
  interrupted: string | null = null;
  running = ["postgres", "server", "worker", "computer"];
  publishedBy: Record<string, string> = {};
  tailscale = "{}";

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (command === "tailscale") return { status: 0, stdout: this.tailscale, stderr: "" };
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
      return {
        status: 0,
        stdout: this.running.map((service) => `${service}\n`).join(""),
        stderr: "",
      };
    }
    const publishFilter = args.find((argument) => argument.startsWith("publish="));
    if (command === "docker" && args[0] === "ps" && publishFilter) {
      const line = this.publishedBy[publishFilter.slice("publish=".length)];
      return { status: 0, stdout: line ? `${line}\n` : "", stderr: "" };
    }
    if (this.failComposeValidation && args.includes("config")) {
      return { status: 1, stdout: "", stderr: "invalid compose" };
    }
    if (this.interrupted && args.includes(this.interrupted)) {
      return { status: 130, stdout: "", stderr: "" };
    }
    if (this.failPull && args.includes("pull")) {
      return { status: 1, stdout: "", stderr: "pull failed" };
    }
    if (this.failStartup && args.includes("up")) {
      return { status: 1, stdout: "", stderr: "startup failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }

  index(argument: string): number {
    return this.calls.findIndex((call) => call.args.includes(argument));
  }
}

/** Calls that would read, connect, or change a model provider. */
const providerCalls = (runner: SetupRunner) =>
  runner.calls.filter((call) => call.args.includes("openteam-pi-auth"));

const localConfiguration = (input: {
  current: ReadonlyMap<string, string>;
  currentOwnerUsername?: string;
}): SetupConfiguration => {
  const apiPort = input.current.get("OPENTEAM_API_PORT") ?? "8787";
  return {
    accessMode: "local",
    bindHost: "127.0.0.1",
    viewerBindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    publicUrl: `http://127.0.0.1:${apiPort}`,
    composeProfiles: "direct",
    ownerUsername: input.currentOwnerUsername ?? "openteam",
    apiPort,
    workerConcurrency: "8",
  };
};

/** A prompter whose session immediately returns a loopback configuration plus overrides. */
const sessionPrompter = (overrides: Partial<SetupConfiguration>): SetupPrompter => {
  const answers = new AnswerPrompter([]);
  return {
    question: (prompt) => answers.question(prompt),
    secret: (prompt) => answers.secret(prompt),
    async session(input) {
      return { ...localConfiguration(input), ...overrides };
    },
    close() {},
  };
};

const createSetupFixture = (options: { authenticated?: boolean; owner?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-cli-provider-setup-"));
  temporaryDirectories.push(directory);
  const paths = installationPaths(directory);
  const state = {
    authenticated: options.authenticated ?? false,
    inference: { providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "high" },
    requests: [] as string[],
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      state.requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/internal/server-settings/inference")) {
        state.inference = (await request.json()) as typeof state.inference;
        return Response.json(state.inference);
      }
      if (url.pathname.endsWith("/internal/server-settings")) {
        return Response.json({ inference: state.inference });
      }
      return Response.json({
        status: "ready",
        runtime: { inference: state.authenticated ? "ready" : "missing" },
        release: { releaseVersion: "1.2.3" },
      });
    },
  });
  servers.push(server);
  const environment = replaceEnvironmentValue(
    createEnvironment({ version: "1.2.3", workerConcurrency: "8" }),
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

/** Capture what setup prints through the presentation and the doctor report. */
const recordingPresentation = () => {
  const output: string[] = [];
  const presentation: SetupPresentation = {
    ...silentPresentation,
    message: (message) => output.push(message),
    summary: (title, rows) =>
      output.push(title, ...rows.map((row) => `${row.label}: ${row.value}`)),
    next: (title, rows, note) =>
      output.push(title, ...rows.map((row) => `${row.label}: ${row.value}`), note),
  };
  return { output, presentation };
};

const capturingConsole = async <T>(
  work: () => Promise<T>
): Promise<{ printed: string; result: T }> => {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values) => {
    lines.push(values.join(" "));
  });
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const result = await work();
    return { printed: lines.join("\n"), result };
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
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

  test("quick setup asks only for the connection and the account", async () => {
    const current = parseEnvironment(
      replaceEnvironmentValue(
        replaceEnvironmentValue(
          createEnvironment({ version: "1.2.3", workerConcurrency: "8" }),
          "OPENTEAM_ACCESS_MODE",
          "private"
        ),
        "OPENTEAM_PUBLIC_HOST",
        "openteam.lan"
      )
    );
    const prompter = new AnswerPrompter([
      "",
      "",
      "sam pillai",
      "Sam-Pillai",
      "correct horse battery staple",
      "correct horse battery staple",
    ]);

    const configuration = await collectSetupConfiguration(current, prompter);

    expect(configuration).toEqual({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "openteam.lan",
      publicUrl: "http://openteam.lan:8787",
      composeProfiles: "direct",
      ownerUsername: "Sam-Pillai",
      ownerPassword: "correct horse battery staple",
      apiPort: "8787",
      workerConcurrency: "8",
    });
    expect(prompter.prompts).toEqual([
      "Connection [1]: ",
      "OpenTeam username: ",
      "OpenTeam username: ",
      "OpenTeam username: ",
      "OpenTeam password: ",
      "Confirm OpenTeam password: ",
    ]);
  });

  test("advanced setup validates server settings with the connection", async () => {
    const current = parseEnvironment(
      createEnvironment({ version: "1.2.3", workerConcurrency: "8" })
    );
    const prompter = new AnswerPrompter([
      "private",
      "https://openteam",
      "openteam.lan",
      "invalid",
      "9444",
      "0",
      "4",
      "sam",
      "correct horse battery staple",
      "correct horse battery staple",
    ]);

    const configuration = await collectSetupConfiguration(current, prompter, {
      advanced: true,
    });

    expect(configuration).toEqual({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "openteam.lan",
      publicUrl: "http://openteam.lan:9444",
      composeProfiles: "direct",
      ownerUsername: "sam",
      ownerPassword: "correct horse battery staple",
      apiPort: "9444",
      workerConcurrency: "4",
    });
    expect(
      prompter.prompts.some((prompt) => /model|provider|inference|thinking/i.test(prompt))
    ).toBe(false);
  });

  test("interactive menus never ask about models or providers", async () => {
    const current = parseEnvironment(
      createEnvironment({ version: "1.2.3", workerConcurrency: "8" })
    );
    const prompter = new SelectionPrompter([], ["local"]);

    const configuration = await collectSetupConfiguration(current, prompter, {
      ownerConfigured: true,
    });

    expect(configuration.accessMode).toBe("local");
    expect(prompter.selections.map((selection) => selection.prompt)).toEqual(["Connection"]);
    expect(prompter.prompts).toEqual([]);
  });

  test("fresh setup reviews the detected private network", async () => {
    const current = parseEnvironment(
      createEnvironment({ version: "1.2.3", workerConcurrency: "8" })
    );
    const prompter = new AnswerPrompter([
      "",
      "sam",
      "correct horse battery staple",
      "correct horse battery staple",
    ]);

    const configuration = await collectSetupConfiguration(current, prompter, {
      fresh: true,
      detectedPrivateHost: "100.100.10.5",
    });

    expect(configuration).toMatchObject({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "100.100.10.5",
      publicUrl: "http://100.100.10.5:8787",
      composeProfiles: "direct",
    });
    expect(prompter.prompts).toHaveLength(4);
  });

  test("reconfiguration keeps the existing owner and does not ask for a password", async () => {
    const current = parseEnvironment(
      createEnvironment({ version: "1.2.3", workerConcurrency: "8" })
    );
    const prompter = new AnswerPrompter([""]);

    const configuration = await collectSetupConfiguration(
      current,
      prompter,
      { ownerConfigured: true },
      "existing.owner"
    );

    expect(configuration.ownerUsername).toBe("existing.owner");
    expect(configuration.ownerPassword).toBeUndefined();
    expect(prompter.prompts).toEqual(["Connection [2]: "]);
  });

  test("public HTTP requires acknowledgement and keeps screen viewers off the Internet", async () => {
    const current = parseEnvironment(
      createEnvironment({ version: "1.2.3", workerConcurrency: "8" })
    );
    const prompter = new AnswerPrompter(["5", "no", "5", "yes", "203.0.113.9", "", "", ""]);

    const configuration = await collectSetupConfiguration(current, prompter, {
      advanced: true,
      fresh: true,
      ownerConfigured: true,
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

  test("first setup saves the connection privately, pulls after the answers, and never touches models", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    let callsWhenAnswered = -1;
    const prompter = new AnswerPrompter([
      "2",
      "",
      "4",
      "Sam-Pillai",
      "correct horse battery staple",
      "correct horse battery staple",
      "yes",
    ]);
    const question = prompter.question.bind(prompter);
    prompter.question = async (prompt) => {
      if (prompt.startsWith("Apply")) callsWhenAnswered = runner.calls.length;
      return question(prompt);
    };
    const { output, presentation } = recordingPresentation();

    await capturingConsole(() =>
      setupCommand(fixture.paths, runner, { advanced: true, presentation }, prompter)
    );

    const updatedContents = readFileSync(fixture.paths.environment, "utf8");
    const updated = parseEnvironment(updatedContents);
    const before = parseEnvironment(fixture.environment);
    expect(updated.get("OPENTEAM_WORKER_CONCURRENCY")).toBe("4");
    expect(updated.get("OPENTEAM_CONTROL_TOKEN")).toBe(before.get("OPENTEAM_CONTROL_TOKEN"));
    expect(updated.get("OPENTEAM_POSTGRES_PASSWORD")).toBe(
      before.get("OPENTEAM_POSTGRES_PASSWORD")
    );
    expect(updatedContents).not.toMatch(/OPENTEAM_PI_|OPENAI_API_KEY|ANTHROPIC/);
    if (process.platform !== "win32")
      expect(statSync(fixture.paths.environment).mode & 0o077).toBe(0);

    // The long download starts only after every question is answered, then the stack starts.
    expect(
      runner.calls.slice(0, callsWhenAnswered).some((call) => call.args.includes("pull"))
    ).toBe(false);
    expect(runner.index("pull")).toBeGreaterThan(runner.index("config"));
    expect(runner.index("up")).toBeGreaterThan(runner.index("pull"));
    expect(output).toContain(
      "Downloading OpenTeam (about 1.5 GB). This can take a few minutes; no more input is needed."
    );
    const ownerCall = runner.calls.find((call) => call.args.includes("owner-credentials"));
    expect(ownerCall?.args).not.toContain("correct horse battery staple");
    expect(ownerCall?.options?.input).toContain('"operation":"setup"');
    expect(readManifest(fixture.paths)?.ownerUsername).toBe("Sam-Pillai");

    expect(providerCalls(runner)).toEqual([]);
    expect(fixture.state.requests.filter((request) => request.includes("server-settings"))).toEqual(
      []
    );
  });

  test("rerunning setup changes the connection without reading or changing the model", async () => {
    const fixture = createSetupFixture({ authenticated: true });
    const inference = { ...fixture.state.inference };
    const runner = new SetupRunner();
    const prompter = new AnswerPrompter(["1", "yes"]);

    await capturingConsole(() =>
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation, detectedPrivateHost: "100.100.10.5" },
        prompter
      )
    );

    const environment = parseEnvironment(readFileSync(fixture.paths.environment, "utf8"));
    expect(environment.get("OPENTEAM_ACCESS_MODE")).toBe("private");
    expect(environment.get("OPENTEAM_PUBLIC_HOST")).toBe("100.100.10.5");
    expect(prompter.prompts).toEqual(["Connection [2]: ", "Apply this configuration? [Y/n/back] "]);
    expect(fixture.state.inference).toEqual(inference);
    expect(fixture.state.requests.every((request) => request === "GET /api/v0/health")).toBe(true);
    expect(providerCalls(runner)).toEqual([]);
    // Existing installations already have their images; updates refresh them.
    expect(runner.index("pull")).toBe(-1);
  });

  test("a busy port keeps the typed answers and returns to the start prompt", async () => {
    const fixture = createSetupFixture();
    const port = parseEnvironment(fixture.environment).get("OPENTEAM_API_PORT")!;
    const runner = new SetupRunner();
    runner.tailscale = JSON.stringify({ TCP: { [port]: { TCPForward: `127.0.0.1:${port}` } } });
    const prompter = new AnswerPrompter(["1", "yes", "no"]);
    const { output, presentation } = recordingPresentation();

    await setupCommand(
      fixture.paths,
      runner,
      { presentation, detectedPrivateHost: "100.94.42.50" },
      prompter
    );

    expect(prompter.prompts).toEqual([
      "Connection [2]: ",
      "Apply this configuration? [Y/n/back] ",
      "Apply this configuration? [Y/n/back] ",
    ]);
    expect(
      output.some((message) => message.includes(`Tailscale Serve already uses port ${port}`))
    ).toBe(true);
    expect(output).toContain("Setup cancelled; no configuration was changed.");
    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.index("up")).toBe(-1);
  });

  test("the interactive session runs startup checks before it returns its answers", async () => {
    const fixture = createSetupFixture();
    const port = parseEnvironment(fixture.environment).get("OPENTEAM_API_PORT")!;
    const runner = new SetupRunner();
    runner.tailscale = JSON.stringify({ TCP: { [port]: { TCPForward: `127.0.0.1:${port}` } } });
    const issues: Array<string | null> = [];
    const answers = new AnswerPrompter([]);
    const prompter: SetupPrompter = {
      question: (prompt) => answers.question(prompt),
      secret: (prompt) => answers.secret(prompt),
      async session(input) {
        const local = localConfiguration(input);
        issues.push(
          await input.check!({
            ...local,
            accessMode: "private",
            bindHost: "0.0.0.0",
            viewerBindHost: "0.0.0.0",
            publicHost: "100.94.42.50",
            publicUrl: `http://100.94.42.50:${port}`,
          })
        );
        issues.push(await input.check!(local));
        return local;
      },
      close() {},
    };

    await capturingConsole(() =>
      setupCommand(fixture.paths, runner, { presentation: silentPresentation }, prompter)
    );

    expect(issues[0]).toContain(`Tailscale Serve already uses port ${port}`);
    expect(issues[1]).toBeNull();
    expect(runner.index("up")).toBeGreaterThan(0);
  });

  test("still refuses a conflict that appears after the session's own check", async () => {
    const fixture = createSetupFixture({ authenticated: true });
    const port = parseEnvironment(fixture.environment).get("OPENTEAM_API_PORT")!;
    const runner = new SetupRunner();
    runner.tailscale = JSON.stringify({ TCP: { [port]: { TCPForward: `127.0.0.1:${port}` } } });

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        sessionPrompter({
          accessMode: "private",
          bindHost: "0.0.0.0",
          publicHost: "100.94.42.50",
          publicUrl: `http://100.94.42.50:${port}`,
        })
      )
    ).rejects.toThrow(`Tailscale Serve already uses port ${port}`);

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.index("up")).toBe(-1);
    expect(runner.index("owner-credentials")).toBe(-1);
  });

  test("ends with the server, username, and where to get the apps", async () => {
    const fixture = createSetupFixture({ owner: false });
    const { output, presentation } = recordingPresentation();
    const { printed } = await capturingConsole(() =>
      setupCommand(
        fixture.paths,
        new SetupRunner(),
        { presentation },
        sessionPrompter({
          accessMode: "private",
          bindHost: "0.0.0.0",
          viewerBindHost: "0.0.0.0",
          publicHost: "100.94.42.50",
          publicUrl: `http://100.94.42.50:${parseEnvironment(fixture.environment).get("OPENTEAM_API_PORT")}`,
          ownerUsername: "openteam",
          ownerPassword: "correct horse battery staple",
        })
      )
    );

    const port = parseEnvironment(fixture.environment).get("OPENTEAM_API_PORT");
    expect(output.slice(output.indexOf("OpenTeam is ready"))).toEqual([
      "OpenTeam is ready",
      `Server: http://100.94.42.50:${port}`,
      "Username: openteam",
      "Next: open the OpenTeam app and sign in with this server and username.",
      "Desktop: https://openteam.so/download",
      "iPhone: https://testflight.apple.com/join/KFBFPkjP",
      "The app will help you connect a model and create your first bot.",
    ]);
    // The connection was just chosen and models belong to the app, so neither is flagged.
    expect(printed).not.toContain("Network exposure");
    expect(printed).not.toContain("Inference");
    expect(printed).not.toContain("openteam setup");
    // Memory and disk come from the machine running the test, so they may add warnings.
    expect(printed).toMatch(/All checks passed\.|Checks passed with \d+ warnings?\./);
  });

  test("a failed image download restores the previous configuration", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    runner.failPull = true;

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        sessionPrompter({ ownerPassword: "correct horse battery staple" })
      )
    ).rejects.toThrow("Could not download OpenTeam");

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.index("up")).toBe(-1);
  });

  test("restores env when Compose rejects the configuration or startup fails", async () => {
    const rejected = createSetupFixture();
    const invalid = new SetupRunner();
    invalid.failComposeValidation = true;
    await expect(
      setupCommand(
        rejected.paths,
        invalid,
        { presentation: silentPresentation },
        sessionPrompter({ workerConcurrency: "4" })
      )
    ).rejects.toThrow("new configuration is invalid");
    expect(readFileSync(rejected.paths.environment, "utf8")).toBe(rejected.environment);
    expect(invalid.index("up")).toBe(-1);

    const failing = createSetupFixture();
    const runner = new SetupRunner();
    runner.failStartup = true;
    await expect(
      setupCommand(
        failing.paths,
        runner,
        { presentation: silentPresentation },
        sessionPrompter({ workerConcurrency: "4" })
      )
    ).rejects.toThrow("previous configuration was restored");
    expect(readFileSync(failing.paths.environment, "utf8")).toBe(failing.environment);
    expect(runner.calls.filter((call) => call.args.includes("up"))).toHaveLength(2);
  });

  test("Ctrl-C during the download stops a first setup with advice and keeps its answers", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    runner.interrupted = "pull";

    const error = await setupCommand(
      fixture.paths,
      runner,
      { presentation: silentPresentation },
      sessionPrompter({ ownerPassword: "correct horse battery staple", workerConcurrency: "4" })
    ).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ exitCode: 130 });
    expect((error as Error).message).toMatch(
      /^Setup was interrupted\. Run .*setup.* to finish setting up OpenTeam\.$/
    );
    // The next run offers the same answers.
    expect(
      parseEnvironment(readFileSync(fixture.paths.environment, "utf8")).get("OPENTEAM_WORKER_CONCURRENCY")
    ).toBe("4");
    expect(runner.index("up")).toBe(-1);
    expect(existsSync(fixture.paths.updateLock)).toBe(false);
  });

  test("a command that Ctrl-C kills outright reports 130, like Docker Compose does", () => {
    expect(new SystemCommandRunner().run("sh", ["-c", "kill -INT $$"]).status).toBe(130);
  });

  test("Ctrl-C that a Docker command fails on still ends setup with the advice and exit 130", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-setup-interrupt-"));
    temporaryDirectories.push(directory);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures/setup-interrupt.ts"), directory],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout).not.toContain("setup failed");
    expect(stderr).toContain("Setup was interrupted.");
    expect(code).toBe(130);
    expect(existsSync(installationPaths(directory).updateLock)).toBe(false);
  }, 15000);

  test("Ctrl-C while an installation restarts puts its configuration back without restarting", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();
    runner.interrupted = "up";

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        sessionPrompter({ workerConcurrency: "4" })
      )
    ).rejects.toMatchObject({
      exitCode: 130,
      message: expect.stringMatching(/^Setup was interrupted/),
    });

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.calls.filter((call) => call.args.includes("up"))).toHaveLength(1);
  });

  test("a first setup that cannot start says how to retry instead of starting placeholder settings", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    runner.failStartup = true;

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        sessionPrompter({
          ownerPassword: "correct horse battery staple",
          workerConcurrency: "4",
        })
      )
    ).rejects.toThrow(
      /^OpenTeam did not start: Docker Compose failed: startup failed\. Fix the problem, then run .*setup.* again\.$/
    );

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.calls.filter((call) => call.args.includes("up"))).toHaveLength(1);
  });

  test("a first setup recreates its containers; a later one only applies changes", async () => {
    const first = createSetupFixture({ owner: false });
    const fresh = new SetupRunner();
    await capturingConsole(() =>
      setupCommand(
        first.paths,
        fresh,
        { presentation: silentPresentation },
        sessionPrompter({
          ownerUsername: "sam",
          ownerPassword: "correct horse battery staple",
          workerConcurrency: "4",
        })
      )
    );
    expect(fresh.calls.find((call) => call.args.includes("up"))?.args).toContain(
      "--force-recreate"
    );

    const existing = createSetupFixture();
    const rerun = new SetupRunner();
    await capturingConsole(() =>
      setupCommand(
        existing.paths,
        rerun,
        { presentation: silentPresentation },
        sessionPrompter({ workerConcurrency: "4" })
      )
    );
    expect(rerun.calls.find((call) => call.args.includes("up"))?.args).not.toContain(
      "--force-recreate"
    );
  });

  test("a failed download ends its reason with a sentence before the advice", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    runner.failPull = true;

    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { presentation: silentPresentation },
        sessionPrompter({ ownerPassword: "correct horse battery staple" })
      )
    ).rejects.toThrow(
      "Could not download OpenTeam: Docker Compose failed: pull failed. Check your"
    );
  });

  test("uses the CLI version in setup and labels the installed server release separately", async () => {
    const fixture = createSetupFixture({ authenticated: true, owner: true });
    const prompter = sessionPrompter({});
    const collect = prompter.session!;
    prompter.session = async (input) => {
      expect(input.version).toBe(CLI_VERSION);
      expect(input.stages.map((stage) => stage.label)).toEqual([
        "Connection",
        "Account",
        "Review",
        "Checks",
      ]);
      expect(input.notes).toContainEqual({
        text: "Installed server release: v1.2.3.",
        tone: "muted",
      });
      return collect(input);
    };
    const { output, presentation } = recordingPresentation();
    await capturingConsole(() =>
      setupCommand(fixture.paths, new SetupRunner(), { presentation }, prompter)
    );
    expect(output).toContain("Installed server release: v1.2.3");
  });

  test("an existing installation refuses setup while another OpenTeam server answers on its port", async () => {
    const fixture = createSetupFixture({ authenticated: true });
    const runner = new SetupRunner();
    runner.running = ["postgres"];
    const port = parseEnvironment(fixture.environment).get("OPENTEAM_API_PORT");
    runner.publishedBy = { [String(port)]: "openteam-dev-server-1\topenteam-dev" };
    const prompter = new AnswerPrompter([]);

    await expect(
      setupCommand(fixture.paths, runner, { presentation: silentPresentation }, prompter)
    ).rejects.toThrow(
      "Another OpenTeam server is answering at http://127.0.0.1:" +
        `${port}, but this installation's server is not running. It is container openteam-dev-server-1 (Compose project openteam-dev).`
    );
    expect(prompter.prompts).toHaveLength(0);
    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(runner.index("up")).toBe(-1);
  });

  test("a new installation moves to a free port when another OpenTeam server has the default", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    runner.running = ["postgres"];
    const port = parseEnvironment(fixture.environment).get("OPENTEAM_API_PORT");
    runner.publishedBy = { [String(port)]: "openteam-server-1\topenteam" };
    const seen: Array<Parameters<NonNullable<SetupPrompter["session"]>>[0]> = [];
    const answers = new AnswerPrompter([]);
    const prompter: SetupPrompter = {
      question: (prompt) => answers.question(prompt),
      secret: (prompt) => answers.secret(prompt),
      session: async (input) => {
        seen.push(input);
        return null;
      },
      close() {},
    };

    await setupCommand(fixture.paths, runner, { presentation: silentPresentation }, prompter);

    const offered = seen[0]?.current.get("OPENTEAM_API_PORT");
    expect(offered).toBeDefined();
    expect(offered).not.toBe(port);
    expect(seen[0]?.notes?.map((note) => note.text)).toContain(
      `Port ${port} is already in use; using ${offered} as the local API default.`
    );
  });

  test("explicit Tailscale HTTPS failure restores the previous configuration without HTTP fallback", async () => {
    const fixture = createSetupFixture({ authenticated: true });
    const runner = new SetupRunner();
    const originalRun = runner.run.bind(runner);
    const host = "bot.tail123.ts.net";
    runner.run = (command, args, options) => {
      if (command !== "tailscale") return originalRun(command, args, options);
      runner.calls.push({ command, args, options });
      return args[0] === "status"
        ? {
            status: 0,
            stdout: JSON.stringify({
              BackendState: "Running",
              Self: { DNSName: `${host}.`, TailscaleIPs: ["100.100.10.5"] },
              CertDomains: [host],
            }),
            stderr: "",
          }
        : args.includes("--bg")
          ? { status: 1, stdout: "", stderr: "Serve permission denied" }
          : { status: 0, stdout: "{}", stderr: "" };
    };
    const { output, presentation } = recordingPresentation();
    const prompter = sessionPrompter({
      accessMode: "tailscale",
      publicUrl: `https://${host}`,
    });
    const collect = prompter.session!;
    prompter.session = (input) => {
      expect(input.preferredHttpsHost).toBe(host);
      return collect(input);
    };
    await expect(
      setupCommand(
        fixture.paths,
        runner,
        { fresh: true, detectedPrivateHost: "100.100.10.5", presentation },
        prompter
      )
    ).rejects.toThrow("Previous configuration restored");
    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(output.some((message) => message.includes("Keeping private HTTP"))).toBe(false);
  });

  test("cancels setup without changing anything", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();

    await setupCommand(
      fixture.paths,
      runner,
      { presentation: silentPresentation },
      new AnswerPrompter(["", "no"])
    );

    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(providerCalls(runner)).toEqual([]);
    expect(runner.index("up")).toBe(-1);
  });

  test("applies a configuration produced by an interactive session and records it", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    const { output, presentation } = recordingPresentation();
    const seen: Array<Parameters<NonNullable<SetupPrompter["session"]>>[0]> = [];
    const prompter = sessionPrompter({
      ownerUsername: "session.owner",
      ownerPassword: "correct horse battery staple",
    });
    const collect = prompter.session!;
    prompter.session = (input) => {
      seen.push(input);
      return collect(input);
    };

    await capturingConsole(() => setupCommand(fixture.paths, runner, { presentation }, prompter));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      version: CLI_VERSION,
      fresh: true,
      ownerConfigured: false,
      currentOwnerUsername: "",
    });
    expect(output).toContain("Configuration ready");
    expect(output).toContain("Username: session.owner");
    expect(readManifest(fixture.paths)?.ownerUsername).toBe("session.owner");
    expect(providerCalls(runner)).toEqual([]);
  });

  test("a cancelled interactive session leaves the installation untouched", async () => {
    const fixture = createSetupFixture();
    const runner = new SetupRunner();
    const { output, presentation } = recordingPresentation();
    const answers = new AnswerPrompter([]);
    const prompter: SetupPrompter = {
      question: (prompt) => answers.question(prompt),
      secret: (prompt) => answers.secret(prompt),
      session: async () => null,
      close() {},
    };

    await setupCommand(fixture.paths, runner, { presentation }, prompter);

    expect(output).toContain("Setup cancelled; no configuration was changed.");
    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
    expect(providerCalls(runner)).toEqual([]);
    expect(runner.index("up")).toBe(-1);
  });

  test("a cancelled first setup says how to finish it later", async () => {
    const fixture = createSetupFixture({ owner: false });
    const runner = new SetupRunner();
    const { output, presentation } = recordingPresentation();
    const answers = new AnswerPrompter([]);
    const prompter: SetupPrompter = {
      question: (prompt) => answers.question(prompt),
      secret: (prompt) => answers.secret(prompt),
      session: async () => null,
      close() {},
    };

    await setupCommand(fixture.paths, runner, { presentation }, prompter);

    expect(output).toContain("Setup cancelled; no configuration was changed.");
    expect(output.at(-1)).toMatch(
      /^Run .*setup.* when you're ready to finish setting up OpenTeam\.$/
    );
    expect(readFileSync(fixture.paths.environment, "utf8")).toBe(fixture.environment);
  });

  test("password-only account updates pass the secret over stdin and never command arguments", async () => {
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
    const runner = new SetupRunner();
    await accountUpdateCommand(
      paths,
      runner,
      { password: true },
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

    const usernameRunner = new SetupRunner();
    await accountUpdateCommand(paths, usernameRunner, {
      username: "Renamed.Owner",
      password: false,
    });
    const usernameCall = usernameRunner.calls.find((candidate) =>
      candidate.args.includes("owner-credentials")
    );
    expect(usernameCall?.options?.input).toBe(
      JSON.stringify({ operation: "update", username: "Renamed.Owner" })
    );
    expect(readManifest(paths)?.ownerUsername).toBe("Renamed.Owner");

    const bothRunner = new SetupRunner();
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
        username: "Final.Owner",
        password: "another correct horse battery",
      })
    );
    expect(readManifest(paths)?.ownerUsername).toBe("Final.Owner");
  });
});
