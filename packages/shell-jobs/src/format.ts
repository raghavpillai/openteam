/** Inline Shell output is cut to its first and last 10,000 characters, as in the reference. */
export const SHELL_CHAR_HARD_LIMIT = 20_000;
/** Foreground output above this many bytes goes to a file instead of the result. */
export const SHELL_FILE_OUTPUT_THRESHOLD_BYTES = 40_000;

export interface ShellOutputExcerpt { output: string; truncated: boolean }

export const truncateShellOutput = (output: string): ShellOutputExcerpt => {
  if (output.length <= SHELL_CHAR_HARD_LIMIT) return { output, truncated: false };
  const half = SHELL_CHAR_HARD_LIMIT / 2;
  return { output: `${output.slice(0, half)}\n\n... (output truncated) ...\n\n${output.slice(-half)}`, truncated: true };
};

const NEWLINE = Buffer.from("\n");

/** Keeps the head and tail of merged stdout/stderr in bounded memory, plus the
 * raw byte and line totals the spill decision and its summary need. */
export class ShellOutputCollector {
  bytes = 0;
  lines = 0;
  private head: Buffer[] = [];
  private headBytes = 0;
  private keptBytes = 0;
  private tail = Buffer.alloc(0);
  private stream?: string;
  private endsWithNewline = true;

  constructor(private readonly keepBytes = SHELL_FILE_OUTPUT_THRESHOLD_BYTES) {}

  push(chunk: Buffer, stream: string) {
    if (!chunk.length) return;
    this.bytes += chunk.length;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) this.lines++;
    // Like the reference, a switch between stdout and stderr mid-line starts a new line.
    const data = this.stream !== undefined && this.stream !== stream && !this.endsWithNewline ? Buffer.concat([NEWLINE, chunk]) : chunk;
    this.stream = stream;
    this.endsWithNewline = chunk[chunk.length - 1] === 10;
    this.keptBytes += data.length;
    if (this.headBytes < this.keepBytes) {
      const piece = data.subarray(0, this.keepBytes - this.headBytes);
      this.head.push(Buffer.from(piece));
      this.headBytes += piece.length;
    }
    const tail = Buffer.concat([this.tail, data]);
    this.tail = Buffer.from(tail.subarray(Math.max(0, tail.length - this.keepBytes)));
  }

  excerpt(): ShellOutputExcerpt {
    const head = Buffer.concat(this.head).toString("utf8");
    if (this.keptBytes <= this.keepBytes) return truncateShellOutput(head);
    const half = SHELL_CHAR_HARD_LIMIT / 2;
    return { output: `${head.slice(0, half)}\n\n... (output truncated) ...\n\n${this.tail.toString("utf8").slice(-half)}`, truncated: true };
  }
}

export const formatOutputLocationSummary = (location: { filePath: string; sizeBytes: number; lineCount?: number }) =>
  `${location.filePath}${location.lineCount === undefined ? "" : ` (${location.sizeBytes >= 1024 ? `${(location.sizeBytes / 1024).toFixed(1)} KB` : `${location.sizeBytes} bytes`}, ${location.lineCount} lines)`}`;

const fenced = (excerpt: ShellOutputExcerpt) => `\`\`\`\n${excerpt.output}\n\`\`\``;

export const SHELL_OOM_NOTE =
  "This command was killed by signal 9 (SIGKILL), possibly because the machine ran out of memory. If nothing else killed it, use less memory: run fewer jobs in parallel, process data in smaller batches, or stop background processes you no longer need.";

export function formatShellCompletedResult(result: {
  exitCode: number;
  elapsedMs: number;
  output?: ShellOutputExcerpt;
  outputLocation?: { filePath: string; sizeBytes: number; lineCount?: number };
  workingDirectory?: string;
  note?: string;
}): string {
  const body = result.outputLocation
    ? `Command output has been written to: ${formatOutputLocationSummary(result.outputLocation)}`
    : `Command output${result.output?.truncated ? ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)` : ""}:\n\n${fenced(result.output ?? { output: "", truncated: false })}`;
  const state = `Shell state (cwd, env vars) persists for subsequent calls.${result.workingDirectory?.trim() ? ` Current directory: ${result.workingDirectory}` : ""}`;
  return `Exit code: ${result.exitCode}\n\n${body}\n\nCommand completed in ${result.elapsedMs} ms.\n\n${state}${result.note ? `\n\n${result.note}` : ""}`;
}

export const shellTimedOutIntro = (blockMs: number) =>
  `The command did not complete in ${blockMs}ms and was sent to the background.`;

export function formatShellBackgroundedResult(result: {
  intro: string;
  shellId: string;
  pid?: number;
  outputPath: string;
  partial: ShellOutputExcerpt;
}): string {
  const section = result.partial.output.length
    ? `Output collected before backgrounding${result.partial.truncated ? " (truncated)" : ""}:\n\n${fenced(result.partial)}`
    : "No output was collected before backgrounding.";
  return `${result.intro}\nShell ID: ${result.shellId}\n${result.pid ? `PID: ${result.pid}\n` : ""}The output is being written to ${result.outputPath}. Don't mention Shell ID to the user.\n\n${section}`;
}

export const formatShellStartedResult = (result: { shellId: string; pid?: number; command: string; outputPath: string }) =>
  `Background command started successfully.\nShell ID: ${result.shellId}\n${result.pid ? `PID: ${result.pid}\n` : ""}Command: ${result.command}\nOutput will be written to ${result.outputPath}. Don't mention Shell ID to the user.`;

export function formatInterruptedShellResult(elapsedMs: number, partial: ShellOutputExcerpt): string {
  const interrupted = `Error: Shell command was interrupted by the user after ${elapsedMs}ms before it completed.`;
  return partial.output.length
    ? `${interrupted}\n\nOutput collected before interruption${partial.truncated ? " (truncated)" : ""}:\n\n${fenced(partial)}`
    : interrupted;
}

const yamlString = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;

export type TerminalStatus = "running" | "succeeded" | "failed" | "aborted";

/** The reference terminal-file frontmatter. Fixed-width status and running time keep
 * its byte length stable so it can be rewritten in place while output is appended. */
export function terminalFrontmatter(header: {
  pid?: number;
  cwd: string;
  command: string;
  title?: string;
  status: TerminalStatus;
  startedAt: string;
  runningForMs: number;
}): string {
  return [
    "---",
    ...(header.pid ? [`pid: ${header.pid}`] : []),
    `cwd: ${yamlString(header.cwd)}`,
    `command: ${yamlString(header.command)}`,
    ...(header.title?.trim() ? [`title: ${yamlString(header.title)}`] : []),
    `status: ${header.status.padEnd(9)}`,
    `started_at: ${header.startedAt}`,
    `running_for_ms: ${String(header.runningForMs).padEnd(9)}`,
    "---",
    "",
  ].join("\n");
}

export const terminalFooter = (exitCode: number | null, elapsedMs: number, endedAt = new Date()) =>
  `\n---\nexit_code: ${exitCode ?? "unknown"}\nelapsed_ms: ${elapsedMs}\nended_at: ${endedAt.toISOString()}\n---\n`;

export const TERMINAL_FOOTER = /\n---\nexit_code: (-?\d+|unknown)\nelapsed_ms: (\d+)\nended_at: [^\n]+\n---\n$/;
