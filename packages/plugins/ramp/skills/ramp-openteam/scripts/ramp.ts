import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CLI_VERSION = "0.2.97";
const releases: Record<string, { platform: string; sha256: string }> = {
  "darwin-arm64": {
    platform: "darwin-arm64",
    sha256: "7c255cd64600a5abe5ab8e2f001087581425658d417a3459ac57072d4a14f3fe",
  },
  "darwin-x64": {
    platform: "darwin-amd64",
    sha256: "feb7a4c5f135d94b69cc97007392605e38887b5d29b8f99266a4c7a207df3219",
  },
  "linux-arm64": {
    platform: "linux-arm64",
    sha256: "3104fd57e46b83da564f0a8248cc554683f6cb3a9485f329a96c579bc23d3c8b",
  },
  "linux-x64": {
    platform: "linux-amd64",
    sha256: "c2edc4b009f78c00608a4693512c2e27629a928e74316a77c7ff68d0daf50011",
  },
};

export function rampHome(env: NodeJS.ProcessEnv = process.env): string {
  let workspace = false;
  try {
    accessSync("/workspace", constants.W_OK | constants.X_OK);
    workspace = true;
  } catch {}
  const root =
    env.OPENTEAM_RAMP_HOME ??
    (workspace
      ? "/workspace/.local/share/openteam/ramp"
      : join(homedir(), ".local/share/openteam/ramp"));
  if (!isAbsolute(root)) throw new Error("OPENTEAM_RAMP_HOME must be an absolute path.");
  return root;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink())
    throw new Error("Ramp state directories must not be symlinks.");
  await chmod(path, 0o700);
}

export async function accountEnvironment(
  account: string,
  env = process.env
): Promise<NodeJS.ProcessEnv> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(account))
    throw new Error("Use the selected OpenTeam connection ID as the account key.");
  const root = rampHome(env);
  await privateDirectory(root);
  const accounts = join(root, "accounts");
  await privateDirectory(accounts);
  const configuration = join(accounts, account);
  await privateDirectory(configuration);
  const result: NodeJS.ProcessEnv = {
    ...env,
    XDG_CONFIG_HOME: configuration,
    RAMP_NO_SESSION_SYNC: "1",
  };
  // A caller's active profile must not override this account's saved selection.
  delete result.RAMP_PROFILE;
  return result;
}

async function checkedVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = Bun.spawn([executable, "--version"], { env, stdout: "pipe", stderr: "pipe" });
  const [status, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0 || stdout.trim() !== `ramp-cli, version ${CLI_VERSION}`)
    throw new Error(
      "Unexpected managed Ramp CLI version. Inspect the installation before replacing it."
    );
  return executable;
}

async function runInstallerCommand(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`Ramp CLI installation failed. ${stderr.trim().slice(0, 500)}`);
}

export async function ensureCli(env = process.env): Promise<string> {
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release) throw new Error("Ramp CLI supports macOS and Linux on ARM64 or x64.");
  const root = rampHome(env);
  await privateDirectory(root);
  const parent = join(root, "cli", CLI_VERSION);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const checkEnv = {
    ...env,
    XDG_CONFIG_HOME: join(parent, "version-check"),
    RAMP_NO_SESSION_SYNC: "1",
  };
  const destination = join(parent, release.platform);
  const executable = join(destination, `ramp-${release.platform}`);
  if (await Bun.file(executable).exists()) return checkedVersion(executable, checkEnv);

  // Stage on the executable destination filesystem. The Bot computer's /tmp is noexec.
  const temporary = await mkdtemp(join(parent, ".install-"));
  try {
    const archive = join(temporary, "ramp.tar.gz");
    const url = `https://github.com/ramp-public/ramp-cli/releases/download/v${CLI_VERSION}/ramp-${release.platform}.tar.gz`;
    await runInstallerCommand([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--tlsv1.2",
      "--connect-timeout",
      "15",
      "--max-time",
      "120",
      "--output",
      archive,
      url,
    ]);
    const digest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    if (digest !== release.sha256)
      throw new Error("Ramp CLI archive checksum mismatch. Nothing was installed.");
    const extracted = join(temporary, "release");
    await mkdir(extracted);
    await runInstallerCommand(["tar", "-xzf", archive, "-C", extracted, "--strip-components=1"]);
    await checkedVersion(join(extracted, `ramp-${release.platform}`), checkEnv);
    try {
      await rename(extracted, destination);
    } catch (error) {
      // Another process may have published this immutable release while we downloaded it.
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
    return await checkedVersion(executable, checkEnv);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "install") {
    console.log(await ensureCli());
    return 0;
  }
  if (args[0] !== "--account" || !args[1] || args.length < 3)
    throw new Error(
      "Usage: bun ramp.ts install | bun ramp.ts --account <connection-id> <ramp arguments>"
    );
  const env = await accountEnvironment(args[1]);
  const executable = await ensureCli(env);
  const child = Bun.spawn([executable, ...args.slice(2)], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Ramp CLI failed.");
    process.exitCode = 1;
  }
}
