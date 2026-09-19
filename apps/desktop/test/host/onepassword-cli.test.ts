import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  readFile,
  symlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  ManagedOnePasswordCli,
  MANAGED_ONEPASSWORD_CLI_VERSION,
  downloadOnePasswordCli,
  onePasswordArtifact,
  onePasswordExecutable,
  privateCliCommand,
  onePasswordFailureKind,
} from "../../src/main/host/onepassword-cli";
import { onePasswordErrorMessage } from "@openteam/contracts/saved-logins";

const roots: string[] = [];

test("provider errors are classified without exposing raw stderr or credentials", async () => {
  for (const [message, code] of [
    ["authorization denied", "denied"],
    ["too many service accounts", "service-account-limit"],
    ["cli is not enabled", "integration-off"],
    ["permission forbidden", "permission"],
    ["already exists", "conflict"],
    ["timed out", "timeout"],
  ] as const)
    expect(onePasswordFailureKind(message)).toBe(code);
  try {
    await privateCliCommand(process.execPath, [
      "-e",
      'console.error("permission forbidden: SYNTHETIC-PRIVATE-ERROR");process.exit(1)',
    ]);
    throw new Error("Expected private runner rejection");
  } catch (error) {
    expect(String(error)).toContain("[permission]");
    expect(String(error)).not.toContain("SYNTHETIC-PRIVATE-ERROR");
    expect(onePasswordErrorMessage(error, "fallback")).toContain("Manage Vault");
  }
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Stored ZIP fixture: no external archiver or credential provider is involved.
function archive(
  entries = [
    { name: "op", value: "synthetic executable", mode: 0o100700 },
    { name: "op.sig", value: "signature", mode: 0o100600 },
  ]
) {
  const local: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    directory.push(central, name);
    offset += header.length + name.length + data.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "managed-op-test-")));
  roots.push(root);
  const launcher = join(root, "launcher");
  await writeFile(launcher, "fixture", { mode: 0o700 });
  const calls: Array<{ file: string; args: string[] }> = [];
  let downloads = 0,
    rejectSignature = false,
    version = MANAGED_ONEPASSWORD_CLI_VERSION;
  const options = {
    dataDir: root,
    launcherPath: launcher,
    platform: "darwin",
    arch: "arm64",
    systemPaths: [] as string[],
    run: async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file.endsWith("codesign")) {
        if (rejectSignature && args.some((arg) => arg.includes("com.1password.op")))
          throw new Error("signature invalid");
        return "";
      }
      if (args.at(-1) === "--version") return version;
      return "[]";
    },
    download: async () => {
      downloads++;
      return archive();
    },
  };
  return {
    root,
    launcher,
    options,
    calls,
    downloads: () => downloads,
    rejectSignature: () => {
      rejectSignature = true;
    },
    version: (next: string) => {
      version = next;
    },
  };
}

test("managed CLI installs atomically, validates before execution, reuses cache and serializes installation", async () => {
  const f = await fixture(),
    cli = new ManagedOnePasswordCli(f.options);
  const paths = await Promise.all([cli.resolve(), cli.resolve()]);
  expect(paths).toEqual([cli.managedPath, cli.managedPath]);
  expect(f.downloads()).toBe(1);
  expect(await readFile(cli.managedPath, "utf8")).toBe("synthetic executable");
  expect(await readdir(dirname(cli.managedPath))).toEqual(["op"]);
  expect(await cli.resolve()).toBe(cli.managedPath);
  expect(f.downloads()).toBe(1);
  await cli.command("op", ["account", "list", "--format=json"]);
  expect(f.calls.at(-1)).toMatchObject({
    file: f.launcher,
    args: [f.root, cli.managedPath, "account", "list", "--format=json"],
  });
  const firstVersion = f.calls.findIndex((call) => call.args.at(-1) === "--version");
  expect(
    f.calls
      .slice(0, firstVersion)
      .some((call) => call.args.some((arg) => arg.includes("com.1password.op")))
  ).toBe(true);
  await expect(cli.command("op", ["item", "get", "private"])).rejects.toThrow("Unsupported");
});

test("a supported verified system CLI avoids the download", async () => {
  const f = await fixture(),
    system = join(f.root, "system-op");
  await writeFile(system, "fixture", { mode: 0o700 });
  const cli = new ManagedOnePasswordCli({ ...f.options, systemPaths: [system] });
  for (const version of ["2.39.0", "2.34.0", "2.35.0-beta.1"]) {
    f.version(version);
    expect(await cli.resolve()).toBe(system);
    expect(f.downloads()).toBe(0);
  }
});

test("provisioning upgrades an older system CLI before running setup commands", async () => {
  const f = await fixture(),
    system = join(f.root, "system-op");
  await writeFile(system, "fixture", { mode: 0o700 });
  const cli = new ManagedOnePasswordCli({
    ...f.options,
    systemPaths: [system],
    run: async (file, args, signal) => {
      if (args.at(-1) === "--version" && args.includes(system)) return "2.34.0";
      return f.options.run(file, args);
    },
  });
  await cli.command("op", ["account", "list", "--format=json"]);
  expect(f.downloads()).toBe(1);
  expect(f.calls.at(-1)?.args).toContain(cli.managedPath);
  expect(f.calls.at(-1)?.args).not.toContain(system);
});

test("untrusted and wrong-version downloads never become an installed executable", async () => {
  for (const mode of ["signature", "version"]) {
    const f = await fixture(),
      cli = new ManagedOnePasswordCli(f.options);
    if (mode === "signature") f.rejectSignature();
    else f.version("2.34.0");
    await expect(cli.resolve()).rejects.toThrow();
    expect(await readdir(dirname(cli.managedPath))).toEqual([]);
  }
});

test("failed download can retry and managed directory symlinks are rejected", async () => {
  const f = await fixture();
  let failed = false;
  const cli = new ManagedOnePasswordCli({
    ...f.options,
    download: async () => {
      if (!failed) {
        failed = true;
        throw new Error("offline");
      }
      return archive();
    },
  });
  await expect(cli.resolve()).rejects.toThrow("offline");
  expect(await cli.resolve()).toBe(cli.managedPath);
  const g = await fixture(),
    elsewhere = join(g.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(g.root, "onepassword-cli"));
  await expect(new ManagedOnePasswordCli(g.options).resolve()).rejects.toThrow("directory");
  expect(await readdir(elsewhere)).toEqual([]);
});

test("cancelling one waiter does not cancel another installation or invoke a credential command", async () => {
  const f = await fixture();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cli = new ManagedOnePasswordCli({
    ...f.options,
    download: async () => {
      await ready;
      return archive();
    },
  });
  const abort = new AbortController();
  const cancelled = cli.command("op", ["account", "list", "--format=json"], abort.signal);
  const other = cli.resolve();
  abort.abort(new Error("cancelled"));
  await expect(cancelled).rejects.toThrow("cancelled");
  release();
  expect(await other).toBe(cli.managedPath);
  expect(f.calls.some((call) => call.args.includes("account"))).toBe(false);
});

test("cancelling the last waiter aborts the download and a later setup can retry", async () => {
  const f = await fixture();
  let started!: () => void,
    attempts = 0,
    cancelled = false;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cli = new ManagedOnePasswordCli({
    ...f.options,
    download: async (_url, signal) => {
      if (++attempts > 1) return archive();
      return new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true }
        );
        started();
      });
    },
  });
  const abort = new AbortController(),
    pending = cli.resolve(abort.signal);
  await downloading;
  abort.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(cancelled).toBe(true);
  expect(await readdir(dirname(cli.managedPath))).toEqual([]);
  expect(await cli.resolve()).toBe(cli.managedPath);
  expect(attempts).toBe(2);
});

test("archive validation rejects traversal, duplicate entries, symlinks, and oversized executable declarations", () => {
  expect(onePasswordExecutable(archive()).toString()).toBe("synthetic executable");
  for (const entries of [
    [
      { name: "../op", value: "bad", mode: 0o100700 },
      { name: "op.sig", value: "s", mode: 0o100600 },
    ],
    [
      { name: "op", value: "bad", mode: 0o120700 },
      { name: "op.sig", value: "s", mode: 0o100600 },
    ],
    [
      { name: "op", value: "x", mode: 0o100700 },
      { name: "op", value: "y", mode: 0o100700 },
    ],
  ])
    expect(() => onePasswordExecutable(archive(entries))).toThrow();
  const huge = archive();
  const central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(0x7fffffff, central + 24);
  expect(() => onePasswordExecutable(huge)).toThrow();
  expect(() => onePasswordExecutable(new Uint8Array())).toThrow();
});

test("downloads enforce vendor, status, type, declared length, truncation, and size limits", async () => {
  const url = onePasswordArtifact("arm64"),
    signal = new AbortController().signal;
  let calls = 0;
  const good = async (_url: unknown, init: any) => {
    calls++;
    expect(init.redirect).toBe("error");
    return new Response("zip", {
      headers: { "content-length": "3", "content-type": "application/zip" },
    });
  };
  expect(
    new TextDecoder().decode(await downloadOnePasswordCli(url, signal, good as typeof fetch))
  ).toBe("zip");
  await expect(
    downloadOnePasswordCli("https://other.example/op.zip", signal, good as typeof fetch)
  ).rejects.toThrow("vendor");
  expect(calls).toBe(1);
  for (const [length, type, status] of [
    ["2", "application/zip", 200],
    ["4", "application/zip", 200],
    ["3", "text/html", 200],
    ["999999999", "application/zip", 200],
    ["3", "application/zip", 503],
  ] as const)
    await expect(
      downloadOnePasswordCli(
        url,
        signal,
        (async () =>
          new Response("zip", {
            status,
            headers: { "content-length": length, "content-type": type },
          })) as typeof fetch
      )
    ).rejects.toThrow();
});
