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
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { accountUpdateCommand, passwordResetCommand } from "../src/password";
import {
  collectSetupConfiguration,
  detectPrivateNetworkHost,
  type SetupPrompter,
  setupCommand,
} from "../src/setup";

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

class SetupRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];

  constructor(private readonly onLogin: () => void) {}

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
    if (args.includes("openbot-pi-login")) this.onLogin();
    return { status: 0, stdout: "", stderr: "" };
  }
}

const temporaryDirectories: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("interactive setup", () => {
  test("quick setup asks only for connection, owner credentials, and provider sign-in", async () => {
    const current = parseEnvironment(
      replaceEnvironmentValue(
        createEnvironment({ version: "1.2.3", timeZone: "UTC" }),
        "OPENBOT_PUBLIC_HOST",
        "openbot.lan"
      )
    );
    const prompter = new AnswerPrompter([
      "private",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
      "",
    ]);

    const configuration = await collectSetupConfiguration(current, false, prompter);

    expect(configuration).toEqual({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "openbot.lan",
      publicUrl: "http://openbot.lan:8787",
      composeProfiles: "direct",
      ownerUsername: "openbot",
      ownerPassword: "correct horse battery staple",
      apiPort: "8787",
      timeZone: "UTC",
      model: "gpt-5.5",
      thinking: "high",
      workerConcurrency: "8",
      authenticate: true,
    });
    expect(prompter.prompts).toHaveLength(5);
  });

  test("advanced setup validates optional server settings", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new AnswerPrompter([
      "private",
      "https://openbot",
      "openbot.lan",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
      "invalid",
      "9444",
      "Mars/Olympus",
      "Europe/London",
      "bad model",
      "gpt-5.5",
      "ultra",
      "xhigh",
      "0",
      "4",
      "",
    ]);

    const configuration = await collectSetupConfiguration(current, false, prompter, {
      advanced: true,
    });

    expect(configuration).toEqual({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "openbot.lan",
      publicUrl: "http://openbot.lan:9444",
      composeProfiles: "direct",
      ownerUsername: "openbot",
      ownerPassword: "correct horse battery staple",
      apiPort: "9444",
      timeZone: "Europe/London",
      model: "gpt-5.5",
      thinking: "xhigh",
      workerConcurrency: "4",
      authenticate: true,
    });
  });

  test("fresh setup defaults to automatic public HTTPS with internal ports kept private", async () => {
    const current = parseEnvironment(createEnvironment({ version: "1.2.3", timeZone: "UTC" }));
    const prompter = new AnswerPrompter([
      "",
      "bot.example.com",
      "",
      "correct horse battery staple",
      "correct horse battery staple",
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
    const prompter = new AnswerPrompter(["local", "no"]);

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
    const directory = mkdtempSync(join(tmpdir(), "openbot-cli-setup-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    let authenticated = false;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          status: "ready",
          runtime: { agent: authenticated ? "ready" : "missing" },
        });
      },
    });
    servers.push(server);

    const original = replaceEnvironmentValue(
      createEnvironment({ version: "1.2.3", timeZone: "UTC" }),
      "OPENBOT_API_PORT",
      String(server.port)
    );
    writeFileAtomic(
      paths.compose,
      `name: openbot\nservices:\n  server:\n    image: example/openbot-server:\${OPENBOT_VERSION}\nvolumes:\n  openbot_workspace:\n`
    );
    writeFileAtomic(paths.environment, original);
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openbot-compose.yaml",
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
    expect(updated.get("OPENBOT_TIME_ZONE")).toBe("Europe/London");
    expect(updated.get("OPENBOT_PI_THINKING")).toBe("xhigh");
    expect(updated.get("OPENBOT_WORKER_CONCURRENCY")).toBe("4");
    expect(updated.get("OPENBOT_CONTROL_TOKEN")).toBe(before.get("OPENBOT_CONTROL_TOKEN"));
    expect(updated.get("OPENBOT_POSTGRES_PASSWORD")).toBe(before.get("OPENBOT_POSTGRES_PASSWORD"));
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
    expect(composeCalls.some((call) => call.args.includes("openbot-pi-login"))).toBe(true);
    const ownerCall = composeCalls.find((call) => call.args.includes("owner-credentials"));
    expect(ownerCall?.args).not.toContain("correct horse battery staple");
    expect(ownerCall?.options?.input).toContain('"operation":"setup"');
    expect(authenticated).toBe(true);
  });

  test("password reset passes the confirmed secret over stdin and never command arguments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-cli-password-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(
      paths.compose,
      "name: openbot\nservices:\n  server:\n    image: example/server\n"
    );
    writeFileAtomic(paths.environment, createEnvironment({ version: "1.2.3" }));
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openbot-compose.yaml",
      installedAt: now,
      updatedAt: now,
      ownerUsername: "openbot",
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
    const directory = mkdtempSync(join(tmpdir(), "openbot-cli-account-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeFileAtomic(
      paths.compose,
      "name: openbot\nservices:\n  server:\n    image: example/server\n"
    );
    writeFileAtomic(paths.environment, createEnvironment({ version: "1.2.3" }));
    const now = new Date().toISOString();
    writeManifest(paths, {
      schemaVersion: 1,
      repository: "owner/repo",
      version: "1.2.3",
      composeUrl: "https://example.com/openbot-compose.yaml",
      installedAt: now,
      updatedAt: now,
      ownerUsername: "openbot",
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
