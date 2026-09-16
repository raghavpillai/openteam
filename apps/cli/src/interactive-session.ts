import { emitKeypressEvents } from "node:readline";
import { CliError } from "./errors";
import { clampViewport, colorEnabled, type SetupSessionFrame } from "./ui";
import type { SessionKey } from "./setup-session";

export type InteractiveOutcome<T> =
  | { type: "continue" }
  | { type: "complete"; value: T }
  | { type: "cancel" }
  | { type: "interrupt" };
export interface InteractiveSession<T> {
  subscribe?(listener: (outcome?: InteractiveOutcome<T>) => void): () => void;
  frame(width: number | undefined, color: boolean): SetupSessionFrame;
  handle(
    character: string,
    key: SessionKey,
    signal: AbortSignal
  ): InteractiveOutcome<T> | Promise<InteractiveOutcome<T>>;
}

/** Shared raw-terminal driver; leaves rendering and input state to each editor. */
export const runInteractiveSession = <T>(
  session: InteractiveSession<T>,
  cancelMessage = "Cancelled."
): Promise<T | null> =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    const abort = new AbortController();
    const styled = colorEnabled();
    let rendered = 0;
    let offset = 0;
    let busy = false;
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    const paint = (lines: readonly string[]) => {
      const chunks: string[] = [];
      if (rendered > 0) chunks.push(`\r${rendered > 1 ? `\x1b[${rendered - 1}A` : ""}`);
      const total = Math.max(rendered, lines.length);
      for (let index = 0; index < total; index++)
        chunks.push(`\x1b[2K${lines[index] ?? ""}${index < total - 1 ? "\n" : ""}`);
      const climb = total - Math.max(lines.length, 1);
      if (climb > 0) chunks.push(`\r\x1b[${climb}A`);
      stdout.write(chunks.join(""));
      rendered = lines.length;
    };
    const render = () => {
      if (finished) return;
      const view = session.frame(stdout.columns, styled);
      const rows = stdout.rows > 0 ? stdout.rows : 24;
      const bodyLimit = Math.max(3, rows - view.header.length - view.footer.length - 1);
      const viewport = clampViewport(
        view.body,
        view.cursorLine,
        bodyLimit,
        offset,
        styled,
        view.cursorEndLine
      );
      offset = viewport.offset;
      paint([...view.header, ...viewport.lines, ...view.footer]);
    };
    const onResize = () => {
      stdout.write("\x1b[2J\x1b[H");
      rendered = 0;
      render();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      abort.abort();
      stdin.off("keypress", onKeypress);
      stdin.off("end", onEnd);
      stdin.off("error", failed);
      stdout.off("resize", onResize);
      stdin.setRawMode?.(Boolean(wasRaw));
      stdin.pause();
      paint([]);
      stdout.write("\x1b[?25h");
    };
    const failed = (error: unknown) => {
      if (!finished) {
        finish();
        reject(error);
      }
    };
    const accept = (outcome: InteractiveOutcome<T>) => {
      if (finished) return;
      busy = false;
      if (outcome.type === "continue") {
        render();
        return;
      }
      finish();
      if (outcome.type === "complete") resolve(outcome.value);
      else if (outcome.type === "cancel") resolve(null);
      else reject(new CliError(cancelMessage));
    };
    const onKeypress = (character = "", key: SessionKey = {}) => {
      if (finished) return;
      if (busy) {
        if (key.ctrl && key.name === "c")
          failed(
            new CliError(
              "Interrupted during a request. A save may have completed; reopen the command to check the current settings."
            )
          );
        return;
      }
      try {
        const result = session.handle(character, key, abort.signal);
        if (result instanceof Promise) {
          busy = true;
          render();
          void result.then(accept, failed);
        } else accept(result);
      } catch (error) {
        failed(error);
      }
    };
    const onEnd = () =>
      failed(new CliError("Terminal input closed. Reopen the command to check saved settings."));
    emitKeypressEvents(stdin);
    stdin.on("keypress", onKeypress);
    stdin.on("end", onEnd);
    stdin.on("error", failed);
    stdout.on("resize", onResize);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdout.write("\x1b[?25l");
    try {
      unsubscribe = session.subscribe?.((outcome) => (outcome ? accept(outcome) : render()));
      render();
    } catch (error) {
      failed(error);
    }
  });
