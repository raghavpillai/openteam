import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  ELECTRON_BUNDLE_ARTIFACTS,
  isElectronBundleArtifact,
  resolveDevElectronEnvironment,
} from "./dev-electron-utils";

type ManagedProcess = ReturnType<typeof Bun.spawn>;
type WaitOn = (options: {
  resources: string[];
  interval?: number;
  tcpTimeout?: number;
}) => Promise<void>;

const desktopRoot = resolve(import.meta.dir, "..");
const bundleRoot = resolve(desktopRoot, "dist-electron");
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const waitOn = require("wait-on") as WaitOn;
const environment = resolveDevElectronEnvironment({
  OPENBOT_DEV_HOST: process.env.OPENBOT_DEV_HOST,
  OPENBOT_RENDERER_URL: process.env.OPENBOT_RENDERER_URL,
});

const bundleCommands = [
  [
    "build",
    "src/main/index.ts",
    "--outdir",
    "dist-electron",
    "--entry-naming",
    "main.js",
    "--chunk-naming",
    "chunks/[name].[ext]",
    "--splitting",
    "--target",
    "node",
    "--format",
    "esm",
    "--external",
    "electron",
  ],
  [
    "build",
    "src/main/host-utility.ts",
    "--outfile",
    "dist-electron/host-utility.js",
    "--target",
    "node",
    "--format",
    "esm",
    "--external",
    "electron",
  ],
  [
    "build",
    "src/preload/index.ts",
    "--outfile",
    "dist-electron/preload.cjs",
    "--target",
    "node",
    "--format",
    "cjs",
    "--external",
    "electron",
  ],
] as const;

const delay = (milliseconds: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const snapshotArtifacts = async () =>
  Promise.all(
    ELECTRON_BUNDLE_ARTIFACTS.map(async (artifact) => {
      const details = await stat(resolve(bundleRoot, artifact));
      return `${artifact}:${details.size}:${details.mtimeMs}`;
    })
  );

const waitForStableArtifacts = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const before = await snapshotArtifacts();
    await delay(50);
    const after = await snapshotArtifacts();
    if (before.every((value, index) => value === after[index])) return;
  }
  throw new Error("Electron development bundles did not stabilize");
};

let shuttingDown = false;
let outputWatcher: FSWatcher | null = null;
let electronProcess: ManagedProcess | null = null;
const bundleWatchers = new Set<ManagedProcess>();
const expectedElectronExits = new Set<ManagedProcess>();

const stopProcess = async (child: ManagedProcess, forceAfterMs = 5_000) => {
  child.kill();
  const exited = await Promise.race([
    child.exited.then(() => true),
    delay(forceAfterMs).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
};

let shutdownTask: Promise<never> | null = null;
const shutdown = (exitCode: number): Promise<never> => {
  if (shutdownTask) return shutdownTask;
  shutdownTask = (async () => {
    shuttingDown = true;
    outputWatcher?.close();
    outputWatcher = null;

    const currentElectron = electronProcess;
    electronProcess = null;
    if (currentElectron) {
      expectedElectronExits.add(currentElectron);
      await stopProcess(currentElectron);
    }

    const watchers = [...bundleWatchers];
    bundleWatchers.clear();
    await Promise.allSettled(watchers.map((child) => stopProcess(child, 2_000)));
    process.exit(exitCode);
  })();
  return shutdownTask;
};

const spawnElectron = () => {
  const child = Bun.spawn([electronPath, desktopRoot], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPENBOT_RENDERER_URL: environment.rendererUrl,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  electronProcess = child;
  console.log(`[electron] started development process ${child.pid}`);

  void child.exited.then((exitCode) => {
    if (electronProcess === child) electronProcess = null;
    if (shuttingDown || expectedElectronExits.has(child)) return;
    console.error(`[electron] development process exited (${exitCode})`);
    void shutdown(exitCode === 0 ? 0 : exitCode);
  });
};

const restartElectron = async () => {
  const previous = electronProcess;
  electronProcess = null;
  if (previous) {
    expectedElectronExits.add(previous);
    console.log("[electron] restarting after main-process bundle change");
    await stopProcess(previous);
  }
  if (!shuttingDown) spawnElectron();
};

let requestedGeneration = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartTask: Promise<void> | null = null;

const drainRestarts = async () => {
  while (!shuttingDown) {
    const generation = requestedGeneration;
    await waitForStableArtifacts();
    await delay(75);
    if (generation !== requestedGeneration) continue;
    await restartElectron();
    if (generation === requestedGeneration) return;
  }
};

const requestRestart = () => {
  requestedGeneration += 1;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (restartTask || shuttingDown) return;
    restartTask = drainRestarts()
      .catch((error) => {
        console.error("[electron] restart failed", error);
      })
      .finally(() => {
        restartTask = null;
        if (!shuttingDown && requestedGeneration > 0) {
          // A bundle may have changed while the prior restart was completing.
          // Queueing is cheap, and the stable-artifact check coalesces it.
          requestedGeneration = 0;
        }
      });
  }, 100);
};

const observedInitialArtifacts = new Set<string>();
let developmentReady = false;
let resolveInitialArtifacts: (() => void) | null = null;
const initialArtifacts = new Promise<void>((resolveInitial) => {
  resolveInitialArtifacts = resolveInitial;
});

outputWatcher = watch(bundleRoot, { recursive: true }, (_event, filename) => {
  if (!isElectronBundleArtifact(filename)) return;
  if (filename === null) {
    for (const artifact of ELECTRON_BUNDLE_ARTIFACTS) observedInitialArtifacts.add(artifact);
  } else {
    observedInitialArtifacts.add(filename.toString());
  }

  if (observedInitialArtifacts.size === ELECTRON_BUNDLE_ARTIFACTS.length) {
    resolveInitialArtifacts?.();
    resolveInitialArtifacts = null;
  }
  if (developmentReady) requestRestart();
});

for (const command of bundleCommands) {
  const child = Bun.spawn([process.execPath, ...command, "--watch", "--no-clear-screen"], {
    cwd: desktopRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  bundleWatchers.add(child);
  void child.exited.then((exitCode) => {
    bundleWatchers.delete(child);
    if (shuttingDown) return;
    console.error(`[electron] bundle watcher exited (${exitCode})`);
    void shutdown(exitCode === 0 ? 1 : exitCode);
  });
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

console.log(`[electron] waiting for ${environment.waitResource}`);
await Promise.all([initialArtifacts, waitOn({ resources: [environment.waitResource] })]);
await waitForStableArtifacts();
developmentReady = true;
requestedGeneration = 0;
spawnElectron();

await new Promise<never>(() => undefined);
