import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHostBridgeDiscovery } from "../src/computer-network-host-bridge";

let directory: string, configurationPath: string;
const watches: ReturnType<typeof startHostBridgeDiscovery>[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openteam-host-bridge-"));
  configurationPath = join(directory, "imessage-bridge.json");
});

afterEach(async () => {
  for (const watch of watches.splice(0)) watch.stop();
  await rm(directory, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  expect(await check()).toBe(true);
}

test("host bridge discovery applies initial absence once, then creation and removal", async () => {
  let calls = 0;
  watches.push(
    startHostBridgeDiscovery("http://unresolvable.invalid:8787", {
      configurationPath,
      intervalMs: 5,
      apply: async () => {
        calls++;
      },
    })
  );
  await until(() => calls === 1);
  await Bun.sleep(25);
  expect(calls).toBe(1);
  await writeFile(configurationPath, "{}", { mode: 0o600 });
  await until(() => calls === 2);
  await rm(configurationPath);
  await until(() => calls === 3);
  await Bun.sleep(25);
  expect(calls).toBe(3);
});

test("host bridge discovery observes atomic replacement with equal size and modification time", async () => {
  await writeFile(configurationPath, "{}", { mode: 0o600 });
  await utimes(configurationPath, new Date(1_000_000), new Date(1_000_000));
  const original = await lstat(configurationPath);
  let calls = 0;
  watches.push(
    startHostBridgeDiscovery("http://server:8787", {
      configurationPath,
      intervalMs: 5,
      apply: async () => {
        calls++;
      },
    })
  );
  await until(() => calls === 1);
  const replacement = join(directory, "replacement.json");
  await writeFile(replacement, "[]", { mode: 0o600 });
  await utimes(replacement, original.atime, original.mtime);
  await rename(replacement, configurationPath);
  const replaced = await lstat(configurationPath);
  expect(replaced.size).toBe(original.size);
  expect(replaced.mtimeMs).toBe(original.mtimeMs);
  expect(replaced.ino).not.toBe(original.ino);
  await until(() => calls === 2);
  await Bun.sleep(25);
  expect(calls).toBe(2);
});

test("host bridge discovery delegates invalid and repaired permissions to the helper", async () => {
  await writeFile(configurationPath, "{}", { mode: 0o600 });
  const modes: number[] = [];
  watches.push(
    startHostBridgeDiscovery("http://server:8787", {
      configurationPath,
      intervalMs: 5,
      apply: async () => {
        modes.push((await lstat(configurationPath)).mode & 0o777);
      },
    })
  );
  await until(() => modes.length === 1);
  await chmod(configurationPath, 0o644);
  await until(() => modes.length === 2);
  await chmod(configurationPath, 0o600);
  await until(() => modes.length === 3);
  expect(modes).toEqual([0o600, 0o644, 0o600]);
});

test("host bridge discovery retries a failed application without another metadata change", async () => {
  await writeFile(configurationPath, "{}", { mode: 0o600 });
  let calls = 0;
  watches.push(
    startHostBridgeDiscovery("http://server:8787", {
      configurationPath,
      intervalMs: 5,
      apply: async () => {
        calls++;
        if (calls === 1) throw new Error("Transient helper failure");
      },
    })
  );
  await until(() => calls === 2);
  await Bun.sleep(25);
  expect(calls).toBe(2);
});

test("host bridge discovery keeps overlapping ticks single flight", async () => {
  let calls = 0,
    release!: () => void;
  const application = new Promise<void>((resolve) => {
    release = resolve;
  });
  watches.push(
    startHostBridgeDiscovery("http://server:8787", {
      configurationPath,
      intervalMs: 5,
      apply: async () => {
        calls++;
        await application;
      },
    })
  );
  await until(() => calls === 1);
  await Bun.sleep(30);
  expect(calls).toBe(1);
  release();
  await Bun.sleep(25);
  expect(calls).toBe(1);
});

test("host bridge discovery observes a configuration change during application", async () => {
  let calls = 0,
    release!: () => void;
  const application = new Promise<void>((resolve) => {
    release = resolve;
  });
  watches.push(
    startHostBridgeDiscovery("http://server:8787", {
      configurationPath,
      intervalMs: 5,
      apply: async () => {
        calls++;
        if (calls === 1) await application;
      },
    })
  );
  await until(() => calls === 1);
  await writeFile(configurationPath, "{}", { mode: 0o600 });
  await Bun.sleep(20);
  expect(calls).toBe(1);
  release();
  await until(() => calls === 2);
  await Bun.sleep(25);
  expect(calls).toBe(2);
});

test.each([
  false,
  true,
])("host bridge shutdown ignores a late application, failure=%s", async (fail) => {
  let calls = 0,
    release!: () => void;
  const application = new Promise<void>((resolve) => {
    release = resolve;
  });
  const watch = startHostBridgeDiscovery("http://server:8787", {
    configurationPath,
    intervalMs: 5,
    apply: async () => {
      calls++;
      await application;
      if (fail) throw new Error("Late helper failure");
    },
  });
  watches.push(watch);
  await until(() => calls === 1);
  watch.stop();
  watch.stop();
  await writeFile(configurationPath, "{}", { mode: 0o600 });
  release();
  await Bun.sleep(30);
  expect(calls).toBe(1);
});

test("host bridge discovery reads only metadata even for an oversized invalid configuration", async () => {
  const file = await open(configurationPath, "w", 0o600);
  try {
    await file.truncate(1024 * 1024 * 1024);
  } finally {
    await file.close();
  }
  let calls = 0;
  watches.push(
    startHostBridgeDiscovery("http://server:8787", {
      configurationPath,
      intervalMs: 5,
      apply: async () => {
        calls++;
      },
    })
  );
  await until(() => calls === 1);
  await Bun.sleep(25);
  expect(calls).toBe(1);
});

test("host bridge discovery invokes isolated Python with bounded arguments and cancels it on shutdown", async () => {
  const helper = join(directory, "helper.py");
  const started = join(directory, "started.json");
  const cancelled = join(directory, "cancelled");
  await writeFile(
    helper,
    [
      "import json, os, signal, sys, time",
      "from pathlib import Path",
      "def stop(signum, frame):",
      `    Path(${JSON.stringify(cancelled)}).touch()`,
      "    sys.exit(0)",
      "signal.signal(signal.SIGTERM, stop)",
      `Path(${JSON.stringify(started)}).write_text(json.dumps({`,
      '    "argv": sys.argv[1:],',
      '    "isolated": sys.flags.isolated,',
      '    "no_site": sys.flags.no_site,',
      '    "environment": sorted(os.environ),',
      "}))",
      "while True:",
      "    time.sleep(0.01)",
    ].join("\n")
  );
  const watch = startHostBridgeDiscovery("http://unresolvable.invalid:8787", {
    configurationPath,
    intervalMs: 5,
    helper,
  });
  watches.push(watch);
  // Creation precedes the helper finishing its write; wait for the complete record.
  let invocation: any;
  await until(async () => {
    try { invocation = JSON.parse(await readFile(started, "utf8")); return true; }
    catch { return false; }
  });
  expect(invocation.argv).toEqual(["--host-bridge", "http://unresolvable.invalid:8787"]);
  expect(invocation.isolated).toBe(1);
  expect(invocation.no_site).toBe(1);
  // Apple's Python launcher may add its own toolchain environment variables.
  expect(invocation.environment).toContain("PATH");
  expect(invocation.environment).not.toContain("HOME");
  expect(invocation.environment).not.toContain("USER");
  watch.stop();
  await until(() =>
    lstat(cancelled).then(
      () => true,
      () => false
    )
  );
});
