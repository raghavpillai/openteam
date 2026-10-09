import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  BoundedUpdateLineBuffer,
  canManageServer,
  MAX_UPDATE_PROGRESS_LINE,
  normalizeSshTarget,
  parseUpdateEvent,
  readManagedInstallation,
  remoteOpenTeamCommand,
  ServerUpdater,
  type ServerUpdateStatus,
  updaterFailureMessage,
} from "../src/main/server-updater";

describe("bounded updater output", () => {
  test("frames split CRLF records without retaining an oversized line", () => {
    const buffer = new BoundedUpdateLineBuffer();
    expect(buffer.push("first\r")).toEqual([]);
    expect(buffer.push("\nsecond\n")).toEqual(["first", "second"]);

    const oversized = "x".repeat(MAX_UPDATE_PROGRESS_LINE + 1);
    expect(buffer.push(oversized)).toEqual([]);
    expect(buffer.bufferedLength).toBe(0);
    expect(buffer.push('\n@@OPENTEAM_UPDATE@@{"phase":"complete","message":"Done"}\n')).toEqual([
      '@@OPENTEAM_UPDATE@@{"phase":"complete","message":"Done"}',
    ]);
  });

  test("handles a large no-newline stream in linear time and bounded space", () => {
    const buffer = new BoundedUpdateLineBuffer();
    const chunk = "x".repeat(64 * 1024);
    const startedAt = performance.now();
    for (let index = 0; index < 1_024; index += 1) buffer.push(chunk);
    const elapsed = performance.now() - startedAt;

    expect(buffer.bufferedLength).toBeLessThanOrEqual(MAX_UPDATE_PROGRESS_LINE);
    expect(elapsed).toBeLessThan(500);
  });
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only permits the client to manage its matching loopback installation", () => {
  const home = mkdtempSync(join(tmpdir(), "openteam-desktop-updater-"));
  temporaryDirectories.push(home);
  const directory = join(home, ".openteam");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "installation.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(directory, ".env"), "OPENTEAM_API_PORT=9444\n");
  writeFileSync(join(directory, "compose.yaml"), "services: {}\n");
  const installation = readManagedInstallation({}, "darwin", home);
  expect(installation?.version).toBe("1.2.3");
  expect(canManageServer("http://127.0.0.1:9444", installation)).toBe(true);
  expect(canManageServer("https://127.0.0.1:9444", installation)).toBe(false);
  expect(canManageServer("http://server.example:9444", installation)).toBe(false);
  expect(canManageServer("http://127.0.0.1:8787", installation)).toBe(false);
});

test("accepts only bounded SSH config destinations", () => {
  expect(normalizeSshTarget("owner@server.example")).toBe("owner@server.example");
  expect(normalizeSshTarget("server-alias")).toBe("server-alias");
  expect(normalizeSshTarget("owner@server.example; reboot")).toBeNull();
  expect(normalizeSshTarget("-oProxyCommand=bad")).toBeNull();
  expect(normalizeSshTarget("-Fbad-config")).toBeNull();
  expect(normalizeSshTarget("owner@-server.example")).toBeNull();
});

const updaterFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-desktop-updater-run-"));
  temporaryDirectories.push(directory);
  const cliPath = join(directory, "openteam-cli.js");
  writeFileSync(join(directory, "installation.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(directory, ".env"), "OPENTEAM_API_PORT=9444\n");
  writeFileSync(join(directory, "compose.yaml"), "services: {}\n");
  writeFileSync(cliPath, "// bundled updater fixture\n");
  return { cliPath, directory, environment: { OPENTEAM_HOME: directory, PATH: "/usr/bin" } };
};

const versionResponse = (version: string) =>
  Response.json({
    releaseVersion: version,
    apiProtocolVersion: 1,
    minimumClientVersion: version,
    recommendedClientVersion: version,
  });

const fakeUpdaterProcess = () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

describe("managed server updater", () => {
  test("coalesces concurrent server discovery without caching explicit refreshes", async () => {
    const fixture = updaterFixture();
    let fetchCount = 0;
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => {
        fetchCount += 1;
        await Promise.resolve();
        return versionResponse("1.2.3");
      },
    });

    const requests = Array.from({ length: 8 }, () =>
      updater.status("https://server.example", "1.3.0")
    );
    const statuses = await Promise.all(requests);
    await updater.status("https://server.example", "1.3.0");

    expect(fetchCount).toBe(2);
    expect(statuses.every((status) => status.currentVersion === "1.2.3")).toBe(true);
  });

  test("reconnects to persisted local progress after the desktop process restarts", async () => {
    const fixture = updaterFixture();
    const jobId = randomUUID();
    mkdirSync(join(fixture.directory, "update.lock"), { mode: 0o700 });
    writeFileSync(
      join(fixture.directory, "update.lock", "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
    );
    writeFileSync(
      join(fixture.directory, "update-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        jobId,
        status: "running",
        phase: "pulling",
        fromVersion: "1.2.3",
        targetVersion: "1.3.0",
        message: "Downloading components",
      })}\n`
    );
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => {
        throw new Error("version endpoint should not delay persisted progress");
      },
    });

    await expect(updater.status("http://127.0.0.1:9444", "1.3.0")).resolves.toMatchObject({
      status: "updating",
      phase: "pulling",
      message: "Downloading components",
      jobId,
      safeToCloseDesktop: true,
    });
  });

  test("reports a standalone CLI that is still staging its update before taking the lock", async () => {
    const fixture = updaterFixture();
    const jobId = randomUUID();
    writeFileSync(
      join(fixture.directory, "update-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        jobId,
        workerPid: process.pid,
        status: "running",
        phase: "updating-cli",
        fromVersion: "1.2.3",
        targetVersion: "1.3.0",
        message: "Downloading and verifying OpenTeam 1.3.0 command-line tools",
      })}\n`
    );
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => versionResponse("1.2.3"),
    });

    await expect(updater.status("http://127.0.0.1:9444", "1.3.0")).resolves.toMatchObject({
      status: "updating",
      phase: "updating-cli",
      jobId,
    });
  });

  test("does not report stale persisted progress as a live update", async () => {
    const fixture = updaterFixture();
    writeFileSync(
      join(fixture.directory, "update-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        jobId: randomUUID(),
        status: "running",
        phase: "restarting",
        fromVersion: "1.2.3",
        targetVersion: "1.3.0",
        message: "Restarting OpenTeam",
      })}\n`
    );
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => versionResponse("1.2.3"),
    });

    await expect(updater.status("http://127.0.0.1:9444", "1.3.0")).resolves.toMatchObject({
      status: "error",
      message: "The update worker stopped unexpectedly. Run the update again to recover safely.",
      safeToCloseDesktop: false,
    });
  });

  test("runs the bundled CLI and publishes a verified successful update", async () => {
    const fixture = updaterFixture();
    const statuses: ServerUpdateStatus[] = [];
    const child = fakeUpdaterProcess();
    let fetchCount = 0;
    let spawnedArguments: readonly string[] = [];
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => versionResponse(fetchCount++ === 0 ? "1.2.3" : "1.3.0"),
      spawnUpdater: (_executable, args) => {
        spawnedArguments = args;
        setTimeout(() => {
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"pulling","message":"Pulling images","version":"1.3.0"}\n'
          );
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"complete","message":"Updated","version":"1.3.0"}\n'
          );
          child.emit("close", 0);
        }, 0);
        return child as never;
      },
      onStatus: (status) => statuses.push({ ...status }),
    });

    const result = await updater.update("http://127.0.0.1:9444", "1.3.0");

    expect(spawnedArguments).toContain("--json-progress");
    expect(spawnedArguments).toContain("--version");
    expect(spawnedArguments).toContain("1.3.0");
    expect(statuses.map((status) => status.phase)).toContain("pulling");
    expect(result).toMatchObject({
      status: "updated",
      phase: "complete",
      currentVersion: "1.3.0",
    });
  });

  test("can request the latest release without pinning a version", async () => {
    const fixture = updaterFixture();
    const child = fakeUpdaterProcess();
    let spawnedArguments: readonly string[] = [];
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => versionResponse("1.2.3"),
      spawnUpdater: (_executable, args) => {
        spawnedArguments = args;
        setTimeout(() => {
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"complete","message":"Updated","version":"1.4.0"}\n'
          );
          child.emit("close", 0);
        }, 0);
        return child as never;
      },
    });

    const result = await updater.update("http://localhost:9444", null);

    expect(spawnedArguments).not.toContain("--version");
    expect(result.currentVersion).toBe("1.4.0");
  });

  test("surfaces rollback progress and the updater failure", async () => {
    const fixture = updaterFixture();
    const statuses: ServerUpdateStatus[] = [];
    const child = fakeUpdaterProcess();
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => versionResponse("1.2.3"),
      spawnUpdater: () => {
        setTimeout(() => {
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"rolling-back","message":"Restoring 1.2.3","version":"1.2.3"}\n'
          );
          child.stderr.write("Docker pull failed\n");
          child.emit("close", 1);
        }, 0);
        return child as never;
      },
      onStatus: (status) => statuses.push({ ...status }),
    });

    await expect(updater.update("http://127.0.0.1:9444", "1.3.0")).rejects.toThrow(
      "Docker pull failed"
    );
    expect(statuses.map((status) => status.phase)).toContain("rolling-back");
    expect(statuses.at(-1)).toMatchObject({ status: "error", message: "Docker pull failed" });
  });

  test("reports a remote server version without enabling Docker management", async () => {
    const fixture = updaterFixture();
    let fetched = false;
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      environment: fixture.environment,
      fetcher: async () => {
        fetched = true;
        return versionResponse("1.2.3");
      },
    });

    const result = await updater.status("https://server.example", "1.3.0");

    expect(fetched).toBe(true);
    expect(result).toMatchObject({
      currentVersion: "1.2.3",
      apiProtocolVersion: 1,
      updaterAvailable: false,
      updateMethod: "manual",
      status: "unavailable",
      manualCommand: "openteam update --version 1.3.0",
    });
  });

  test("reconnects to a remote durable update over read-only SSH status", async () => {
    const fixture = updaterFixture();
    const child = fakeUpdaterProcess();
    let spawnedArguments: readonly string[] = [];
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      sshExecutable: "/usr/bin/ssh",
      environment: fixture.environment,
      fetcher: async () => new Response("unavailable", { status: 503 }),
      spawnUpdater: (_executable, args) => {
        spawnedArguments = args;
        setTimeout(() => {
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"restarting","message":"Restarting OpenTeam","version":"1.3.0","jobId":"job-1","safeToCloseDesktop":true}\n'
          );
          child.emit("close", 0);
        }, 0);
        return child as never;
      },
    });

    await expect(
      updater.status("https://server.example", "1.3.0", "owner@server.example")
    ).resolves.toMatchObject({
      status: "updating",
      phase: "restarting",
      message: "Restarting OpenTeam",
      jobId: "job-1",
      safeToCloseDesktop: true,
    });
    expect(spawnedArguments).toContain("status");
    expect(spawnedArguments).toContain("--json-progress");
  });

  test("updates a remote server through strict non-interactive SSH", async () => {
    const fixture = updaterFixture();
    const child = fakeUpdaterProcess();
    let executable = "";
    let spawnedArguments: readonly string[] = [];
    let spawnedEnvironment: NodeJS.ProcessEnv = {};
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      sshExecutable: "/usr/bin/ssh",
      environment: fixture.environment,
      fetcher: async () => versionResponse("1.3.0"),
      spawnUpdater: (nextExecutable, args, options) => {
        executable = nextExecutable;
        spawnedArguments = args;
        spawnedEnvironment = options.env;
        setTimeout(() => {
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"complete","message":"Updated","version":"1.3.0"}\n'
          );
          child.emit("close", 0);
        }, 0);
        return child as never;
      },
    });

    const result = await updater.update("https://server.example", "1.3.0", "owner@server.example");

    expect(executable).toBe("/usr/bin/ssh");
    expect(spawnedArguments).toContain("BatchMode=yes");
    expect(spawnedArguments).toContain("StrictHostKeyChecking=yes");
    expect(spawnedArguments).toContain("owner@server.example");
    expect(spawnedArguments).toContain("openteam");
    expect(spawnedEnvironment.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(result).toMatchObject({ status: "updated", updateMethod: "ssh" });
  });
});

describe("server updater failures", () => {
  test("reports the CLI's whole wrapped error instead of its last line", () => {
    const output = [
      '@@OPENTEAM_UPDATE@@{"phase":"checking","message":"Checking"}',
      "  ╭────────────────╮",
      "  │ OPENTEAM / error │",
      "  ╰────────────────╯",
      "",
      "  \x1b[31m✗\x1b[0m Refusing to downgrade OpenTeam 0.0.1 to 0.0.0. Use --allow-downgrade only for an",
      "    intentional recovery.",
      "",
    ].join("\n");
    expect(updaterFailureMessage(output, 1)).toBe(
      "Refusing to downgrade OpenTeam 0.0.1 to 0.0.0. Use --allow-downgrade only for an intentional recovery."
    );
    expect(updaterFailureMessage("Host key verification failed.\r\n", 255)).toBe(
      "Host key verification failed."
    );
    expect(updaterFailureMessage("", 3)).toBe("Updater exited with code 3");
  });

  test("retries a remote update through the installer's default CLI directory", async () => {
    const fixture = updaterFixture();
    const attempts: (readonly string[])[] = [];
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      sshExecutable: "/usr/bin/ssh",
      environment: fixture.environment,
      fetcher: async () => versionResponse("1.3.0"),
      spawnUpdater: (_executable, args) => {
        attempts.push(args);
        const child = fakeUpdaterProcess();
        setTimeout(() => {
          if (attempts.length === 1) {
            child.stderr.write("bash: line 1: openteam: command not found\n");
            child.emit("close", 127);
            return;
          }
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"complete","message":"Updated","version":"1.3.0"}\n'
          );
          child.emit("close", 0);
        }, 0);
        return child as never;
      },
    });

    const result = await updater.update("https://server.example", "1.3.0", "owner@server.example");

    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.slice(-5)).toEqual([
      "openteam",
      "update",
      "--version",
      "1.3.0",
      "--json-progress",
    ]);
    expect(attempts[1]?.slice(-8)).toEqual(
      remoteOpenTeamCommand(["update", "--version", "1.3.0", "--json-progress"], true)
    );
    expect(result).toMatchObject({ status: "updated", currentVersion: "1.3.0" });
  });

  test("explains a remote server without the OpenTeam CLI", async () => {
    const fixture = updaterFixture();
    let attempts = 0;
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      sshExecutable: "/usr/bin/ssh",
      environment: fixture.environment,
      fetcher: async () => versionResponse("1.2.3"),
      spawnUpdater: () => {
        attempts += 1;
        const child = fakeUpdaterProcess();
        setTimeout(() => {
          child.stderr.write("sh: 1: exec: openteam: not found\n");
          child.emit("close", 127);
        }, 0);
        return child as never;
      },
    });

    await expect(
      updater.update("https://server.example", "1.3.0", "owner@server.example")
    ).rejects.toThrow("The openteam command was not found on owner@server.example.");
    expect(attempts).toBe(2);
  });

  test("reads remote progress through the default CLI directory", async () => {
    const fixture = updaterFixture();
    const attempts: (readonly string[])[] = [];
    const updater = new ServerUpdater({
      cliPath: fixture.cliPath,
      executablePath: "/Applications/OpenTeam.app/Contents/MacOS/OpenTeam",
      sshExecutable: "/usr/bin/ssh",
      environment: fixture.environment,
      fetcher: async () => new Response("unavailable", { status: 503 }),
      spawnUpdater: (_executable, args) => {
        attempts.push(args);
        const child = fakeUpdaterProcess();
        setTimeout(() => {
          if (attempts.length === 1) {
            child.emit("close", 127);
            return;
          }
          child.stdout.write(
            '@@OPENTEAM_UPDATE@@{"phase":"pulling","message":"Pulling images","version":"1.3.0","jobId":"job-2","safeToCloseDesktop":true}\n'
          );
          child.emit("close", 0);
        }, 0);
        return child as never;
      },
    });

    await expect(
      updater.status("https://server.example", "1.3.0", "owner@server.example")
    ).resolves.toMatchObject({ status: "updating", phase: "pulling", jobId: "job-2" });
    expect(attempts[1]).toContain("sh");
  });
});

describe("CLI update progress", () => {
  test("accepts only the updater's prefixed structured events", () => {
    expect(
      parseUpdateEvent(
        '@@OPENTEAM_UPDATE@@{"phase":"pulling","message":"Pulling images","version":"1.3.0"}'
      )
    ).toEqual({ phase: "pulling", message: "Pulling images", version: "1.3.0" });
    expect(
      parseUpdateEvent(
        '@@OPENTEAM_UPDATE@@{"phase":"updating-cli","message":"Installing command-line tools","version":"1.3.0"}'
      )
    ).toMatchObject({ phase: "updating-cli", version: "1.3.0" });
    expect(parseUpdateEvent("docker pull output")).toBeNull();
    expect(parseUpdateEvent('@@OPENTEAM_UPDATE@@{"phase":"shell","message":"bad"}')).toBeNull();
    expect(
      parseUpdateEvent(
        '@@OPENTEAM_UPDATE@@{"phase":"checking","message":"Accepted","jobId":"job-1","safeToCloseDesktop":true}'
      )
    ).toMatchObject({ jobId: "job-1", safeToCloseDesktop: true });
  });
});
