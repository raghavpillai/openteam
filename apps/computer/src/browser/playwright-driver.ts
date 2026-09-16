import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { BrowserType } from "playwright-core";

export interface OutOfProcessPlaywright {
  playwright: { chromium: BrowserType };
  stop: () => Promise<void>;
}

export let playwrightDriver: Promise<OutOfProcessPlaywright> | null = null;

export const nodeBinary = (): string => {
  const candidates = [
    process.env.OPENTEAM_NODE_BINARY,
    "/usr/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "node")),
  ];
  const resolved = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  );
  if (!resolved) throw new Error("Browser use requires a Node.js executable for Playwright");
  return resolved;
};

export const outOfProcessPlaywright = async (): Promise<OutOfProcessPlaywright> => {
  if (!playwrightDriver) {
    playwrightDriver = (async () => {
      const originalFork = childProcess.fork;
      childProcess.fork = ((
        modulePath: string,
        argsOrOptions?: readonly string[] | childProcess.ForkOptions,
        maybeOptions?: childProcess.ForkOptions
      ) => {
        const args = Array.isArray(argsOrOptions)
          ? (argsOrOptions as readonly string[])
          : undefined;
        const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
        return originalFork(modulePath, args, {
          ...(options as childProcess.ForkOptions),
          execPath: nodeBinary(),
        });
      }) as typeof childProcess.fork;
      try {
        const driverModule = (await import("playwright-core/lib/outofprocess")) as unknown as {
          start: () => Promise<OutOfProcessPlaywright>;
        };
        const driver=await driverModule.start();
        return {...driver,stop:async()=>{try{await driver.stop();}finally{playwrightDriver=null;}}};
      } finally {
        childProcess.fork = originalFork;
      }
    })().catch(error=>{playwrightDriver=null;throw error;});
  }
  return playwrightDriver;
};
