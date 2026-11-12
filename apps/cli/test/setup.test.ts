import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import { accountUpdateCommand } from "../src/password";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  collectSetupConfiguration,
  detectPrivateNetworkHost,
  type SetupConfiguration,
  type SetupPrompter,
  setupCommand,
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

});
