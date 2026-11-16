// Shared test doubles: temporary directories and servers, installed-stack files, a fake
// Docker CLI, a checksummed release server, and a real `openteam` subprocess.
import { afterEach, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createEnvironment,
  type InstallationManifest,
  type InstallationPaths,
  installationPaths,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../../src/config";
import { ComposeProject } from "../../src/docker";
import type { CommandRunner, RunOptions, RunResult } from "../../src/process";

/** Call at a test file's top level; everything it creates is removed after each test. */
export const scratch = () => {
  const directories: string[] = [];
  const servers: Array<{ stop(force?: boolean): void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  const dir = (prefix = "openteam-test-") => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    directories.push(directory);
    return directory;
  };
  const serve = (fetch: (request: Request) => Response | Promise<Response>) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
    servers.push(server);
    return server;
  };
  /** Serves files plus a SHA256SUMS for them; returns the server origin. */
  const release = (files: Record<string, string | Uint8Array>, sums?: string) => {
    const checksums =
      sums ??
      Object.entries(files)
        .map(([name, body]) => `${createHash("sha256").update(body).digest("hex")}  ${name}\n`)
        .join("");
    const server = serve((request) => {
      const name = new URL(request.url).pathname.split("/").at(-1)!;
      if (name === "SHA256SUMS") return new Response(checksums);
      const body = files[name];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(typeof body === "string" ? body : Buffer.from(body));
    });
    return `http://127.0.0.1:${server.port}`;
  };
  return { dir, serve, release };
};

export const RELEASE_COMPOSE =
  "name: openteam\nservices:\n  server:\n    image: example/openteam-server:${OPENTEAM_VERSION}\nvolumes:\n  openteam_workspace:\n";

/** Writes an installed stack: Compose file, environment (with API port), and manifest. */
export const installStack = (
  directory: string,
  options: {
    apiPort?: number | string;
    compose?: string;
    environment?: string;
    manifest?: Partial<InstallationManifest>;
  } = {}
): { paths: InstallationPaths; environment: string } => {
  const paths = installationPaths(directory);
  let environment = options.environment ?? createEnvironment({ version: "1.2.3" });
  if (options.apiPort !== undefined)
    environment = replaceEnvironmentValue(
      environment,
      "OPENTEAM_API_PORT",
      String(options.apiPort)
    );
  writeFileAtomic(paths.compose, options.compose ?? RELEASE_COMPOSE);
  writeFileAtomic(paths.environment, environment);
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.test/openteam-compose.yaml",
    installedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ownerUsername: "openteam",
    ...options.manifest,
  });
  return { paths, environment };
};

export const COMPOSE_V2 = {
  executable: "docker",
  prefix: ["compose"],
  version: "2.30.0",
  supported: true,
} as const;

export const composeProject = (
  paths: InstallationPaths,
  runner: CommandRunner,
  projectName?: string
) => new ComposeProject(paths, COMPOSE_V2, runner, projectName);

export const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

export interface RecordedCall {
  command: string;
  args: readonly string[];
  options?: RunOptions;
}

/**
 * A Docker CLI with a healthy engine, Compose v2, and the four core services. Subclasses
 * override `respond` for anything else; returning undefined falls back to these defaults.
 */
export class FakeDocker implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  running = ["postgres", "server", "worker", "computer"];

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    const custom = this.respond(command, args, options);
    if (custom) return custom;
    if (command === "tailscale") return ok("{}");
    if (command === "docker" && args[0] === "--version") return ok("Docker version 29.0.0");
    if (command === "docker" && args[0] === "info") return ok("29.0.0");
    if (args[0] === "compose" && args[1] === "version") return ok("Docker Compose version v2.30.0");
    if (args.includes("ps") && args.includes("--services"))
      return ok(this.running.map((service) => `${service}\n`).join(""));
    return ok();
  }

  protected respond(
    _command: string,
    _args: readonly string[],
    _options?: RunOptions
  ): RunResult | undefined {
    return undefined;
  }

  index(argument: string): number {
    return this.calls.findIndex((call) => call.args.includes(argument));
  }

  count(argument: string): number {
    return this.calls.filter((call) => call.args.includes(argument)).length;
  }
}

/** Runs `work` with console.log and stdout silenced; returns what was logged. */
export const quietly = async <T>(
  work: () => Promise<T>
): Promise<{ lines: string[]; result: T }> => {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values) => {
    lines.push(values.map(String).join(" "));
  });
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return { lines, result: await work() };
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
};

/** Writes executable stubs (e.g. `docker`) to `<directory>/bin` and returns that directory. */
export const fakeBin = (directory: string, executables: Record<string, string>) => {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, source] of Object.entries(executables))
    writeFileSync(join(bin, name), source, { mode: 0o755 });
  return bin;
};

/** Runs the real CLI entry point in a subprocess. */
export const runCli = async (
  args: string[],
  env: Record<string, string | undefined>,
  bunArguments: string[] = []
) => {
  const child = Bun.spawn(
    [process.execPath, ...bunArguments, resolve(import.meta.dir, "../../src/main.ts"), ...args],
    {
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, output: `${stdout}\n${stderr}`.replace(/\s+/g, " ") };
};
