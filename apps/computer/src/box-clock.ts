import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const BOX_TIMEZONE = "/usr/local/bin/openteam-box-timezone";
const run = promisify(execFile);

const applyWithScript = async (zone: string): Promise<void> => {
  await run(BOX_TIMEZONE, ["apply", zone], { timeout: 10_000 });
};

/**
 * Keeps the box clock on the user's zone. Every turn carries the zone, so a change reaches the
 * box before that turn's first command without restarting the computer. Outside the computer
 * image (no clock script) this does nothing.
 */
export const createBoxClock = (
  apply: ((zone: string) => Promise<void>) | null = existsSync(BOX_TIMEZONE) ? applyWithScript : null,
  log: (line: string) => void = (line) => console.warn(line)
) => {
  let applied: string | undefined;
  let queue = Promise.resolve();
  return (zone: string | undefined): Promise<void> => {
    if (!apply || !zone || zone === applied) return queue;
    queue = queue.then(async () => {
      if (zone === applied) return;
      try {
        await apply(zone);
        applied = zone;
      } catch (error) {
        log(`box-timezone: could not set the box clock to ${zone} (${error instanceof Error ? error.message : String(error)})`);
      }
    });
    return queue;
  };
};
