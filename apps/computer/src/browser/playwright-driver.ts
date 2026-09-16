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
