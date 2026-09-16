import type { InstallationPaths } from "./config";
import { installationCommand } from "./command-ui";
import { TerminalReport, type TerminalOptions } from "./terminal";

export const renderSetupCountdown = (seconds: number, options: TerminalOptions = {}): string => {
  const view = new TerminalReport(options);
  const remaining = Math.max(1, Math.min(5, Math.ceil(seconds)));
  return view.paint(
    `  Starting in ${remaining}s  ${"●".repeat(remaining)}${"○".repeat(5 - remaining)}`,
    "info"
  );
};

export const printSetupCancelled = (paths: InstallationPaths): void => {
  const view = new TerminalReport();
  view.notice("Setup cancelled. The CLI is installed.", "info");
  view.text(`Run ${installationCommand(paths, "setup")} to set up your server.`);
  console.log(view.toString());
};

/** Wait before automatic setup only. Raw input consumes Esc/Enter/paste immediately. */
export const waitForAutomaticSetup = (): Promise<boolean> => {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing === true;
    const animated = process.env.TERM !== "dumb";
    const view = new TerminalReport();
    view.section("Ready for setup");
    view.text("Next: set up your server and account.");
    view.text("Press any key to cancel.", "muted");
    output.write(`${view.toString()}\n\n`);
    let finished = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let painted = false;
    let shown = 0;
    const finish = (proceed: boolean, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      input.off("data", cancel);
      input.off("end", cancel);
      input.off("error", failed);
      process.off("SIGINT", cancel);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      if (animated) output.write("\r\x1b[2K\x1b[?25h");
      if (proceed) output.write(`${view.paint("  ✓ Starting setup…", "success")}\n\n`);
      if (error) reject(error);
      else resolve(proceed);
    };
    const cancel = () => finish(false);
    const failed = (error: unknown) => finish(false, error);
    const started = performance.now();
    const tick = () => {
      const remaining = Math.ceil((5000 - (performance.now() - started)) / 1000);
      if (remaining <= 0) return finish(true);
      if (remaining === shown) return;
      shown = remaining;
      if (painted && animated) output.write("\r\x1b[2K");
      output.write(renderSetupCountdown(remaining, { color: view.color, width: view.width }));
      if (!animated) output.write("\n");
      painted = true;
    };
    try {
      input.setRawMode(true);
      input.on("data", cancel);
      input.on("end", cancel);
      input.on("error", failed);
      process.on("SIGINT", cancel);
      if (animated) output.write("\x1b[?25l");
      timer = setInterval(tick, 50);
      tick();
      input.resume();
    } catch (error) {
      finish(false, error);
    }
  });
};
