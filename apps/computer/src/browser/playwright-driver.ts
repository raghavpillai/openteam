import childProcess from "node:child_process";
import { nodeBinary } from "../node-runtime";
export { nodeBinary } from "../node-runtime";
import type { BrowserType } from "playwright-core";

export interface OutOfProcessPlaywright {
  playwright: { chromium: BrowserType };
  stop: () => Promise<void>;
}

export let playwrightDriver: Promise<OutOfProcessPlaywright> | null = null;

export const outOfProcessPlaywright = async (): Promise<OutOfProcessPlaywright> => {
  if (!playwrightDriver) {
    const generation = (async () => {
      // Import before patching fork so unrelated asynchronous startup work cannot
      // accidentally become part of this driver's lifecycle.
      const driverModule = (await import("playwright-core/lib/outofprocess")) as unknown as {
        start: () => Promise<OutOfProcessPlaywright>;
      };
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
        const child = originalFork(modulePath, args, {
          ...(options as childProcess.ForkOptions),
          execPath: nodeBinary(),
        });
        const invalidate = () => {
          if (playwrightDriver === generation) playwrightDriver = null;
        };
        child.once("exit", invalidate);
        child.once("disconnect", invalidate);
        child.once("error", invalidate);
        return child;
      }) as typeof childProcess.fork;
      try {
        const pending = driverModule.start();
        childProcess.fork = originalFork;
        const driver = await pending;
        return { ...driver, stop: async () => {
          try { await driver.stop(); }
          finally { if (playwrightDriver === generation) playwrightDriver = null; }
        } };
      } finally {
        childProcess.fork = originalFork;
      }
    })().catch(error => {
      if (playwrightDriver === generation) playwrightDriver = null;
      throw error;
    });
    playwrightDriver = generation;
  }
  return playwrightDriver;
};
