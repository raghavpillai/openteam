import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { createEnvironment, parseEnvironment, readManifest } from "../src/config";
import { accountUpdateCommand } from "../src/password";
import type { RunResult } from "../src/process";
import {
  collectSetupConfiguration,
  detectPrivateNetworkHost,
  type SetupConfiguration,
  type SetupPrompter,
  setupCommand,
} from "../src/setup";
import type { SetupPresentation } from "../src/ui";
import { FakeDocker, installStack, quietly, scratch } from "./fixtures/harness";

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

class SetupRunner extends FakeDocker {
  failComposeValidation = false;
  failStartup = false;
  /** Docker Compose exits 130 when the user's Ctrl-C reaches it. */
  interrupted: string | null = null;

  protected override respond(_command: string, args: readonly string[]): RunResult | undefined {
    if (this.failComposeValidation && args.includes("config"))
      return { status: 1, stdout: "", stderr: "invalid compose" };
    if (this.interrupted && args.includes(this.interrupted))
      return { status: 130, stdout: "", stderr: "" };
    if (this.failStartup && args.includes("up"))
      return { status: 1, stdout: "", stderr: "startup failed" };
    return undefined;
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

const s = scratch();

const createSetupFixture = (options: { owner?: boolean } = {}) => {
  const requests: string[] = [];
  const server = s.serve((request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({
      status: "ready",
      runtime: { inference: "missing" },
      release: { releaseVersion: "1.2.3" },
    });
  });
  const { paths, environment } = installStack(s.dir("openteam-cli-provider-setup-"), {
    apiPort: server.port,
    environment: createEnvironment({ version: "1.2.3", workerConcurrency: "8" }),
    compose:
      "name: openteam\nservices:\n  server:\n    image: example/server\n  computer:\n    image: example/computer\n",
    manifest: { ownerUsername: options.owner === false ? undefined : "existing.owner" },
  });
  return { paths, requests, environment };
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

describe("interactive setup", () => {
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
    const iface = (address: string, cidr: string) => [
      { address, cidr, netmask: "", family: "IPv4" as const, mac: "", internal: false },
    ];
    const interfaces = {
      docker0: iface("172.17.0.1", "172.17.0.1/16"),
      en0: iface("192.168.1.20", "192.168.1.20/24"),
      utun4: iface("100.100.10.5", "100.100.10.5/10"),
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

    await quietly(() =>
      setupCommand(fixture.paths, runner, { advanced: true, presentation }, prompter)
    );

    const updatedContents = readFileSync(fixture.paths.environment, "utf8");
    const updated = parseEnvironment(updatedContents);
    const before = parseEnvironment(fixture.environment);
    expect(updated.get("OPENTEAM_WORKER_CONCURRENCY")).toBe("4");
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
    const ownerCall = runner.calls.find((call) => call.args.includes("owner-credentials"));
    expect(ownerCall?.args).not.toContain("correct horse battery staple");
    expect(ownerCall?.options?.input).toContain('"operation":"setup"');
    expect(readManifest(fixture.paths)?.ownerUsername).toBe("Sam-Pillai");
    expect(output).toContain("OpenTeam is ready");
    expect(providerCalls(runner)).toEqual([]);
    expect(fixture.requests.filter((request) => request.includes("server-settings"))).toEqual([]);
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
    expect(runner.count("up")).toBe(2);
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
    expect(runner.count("up")).toBe(1);
  });

  test("password-only account updates pass the secret over stdin and never command arguments", async () => {
    const { paths } = installStack(s.dir("openteam-cli-password-"));
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
