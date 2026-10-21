import { expect, test } from "bun:test";
import {
  ShellOutputCollector,
  TERMINAL_FOOTER,
  formatInterruptedShellResult,
  formatShellBackgroundedResult,
  formatShellCompletedResult,
  formatShellStartedResult,
  shellTimedOutIntro,
  shellUserBackgroundedIntro,
  terminalFooter,
  terminalFrontmatter,
  truncateShellOutput,
} from "../src";

test("inline output keeps its first and last 10,000 characters", () => {
  expect(truncateShellOutput("short")).toEqual({ output: "short", truncated: false });
  const long = `${"a".repeat(15_000)}${"b".repeat(15_000)}`;
  expect(truncateShellOutput(long)).toEqual({
    output: `${"a".repeat(10_000)}\n\n... (output truncated) ...\n\n${"b".repeat(10_000)}`,
    truncated: true,
  });
});

test("the collector bounds memory but keeps both ends, totals and stream breaks", () => {
  const collector = new ShellOutputCollector();
  collector.push(Buffer.from("partial"), "stdout");
  collector.push(Buffer.from("err\n"), "stderr");
  collector.push(Buffer.from("next\n"), "stderr");
  expect(collector.excerpt()).toEqual({ output: "partial\nerr\nnext\n", truncated: false });
  expect([collector.bytes, collector.lines]).toEqual([16, 2]);

  const large = new ShellOutputCollector();
  large.push(Buffer.from(`HEAD${"x".repeat(60_000)}`), "stdout");
  for (let index = 0; index < 100; index++) large.push(Buffer.from("y".repeat(1_000)), "stdout");
  large.push(Buffer.from("TAIL\n"), "stdout");
  const excerpt = large.excerpt();
  expect(excerpt.truncated).toBe(true);
  expect(excerpt.output.startsWith(`HEAD${"x".repeat(9_996)}\n\n... (output truncated) ...\n\n`)).toBe(true);
  expect(excerpt.output.endsWith(`${"y".repeat(9_995)}TAIL\n`)).toBe(true);
  expect([large.bytes, large.lines]).toEqual([160_009, 1]);
});

test("completed, spilled and interrupted results use the reference wording", () => {
  expect(formatShellCompletedResult({ exitCode: 0, elapsedMs: 5, output: truncateShellOutput("ok\n") })).toBe(
    "Exit code: 0\n\nCommand output:\n\n```\nok\n\n```\n\nCommand completed in 5 ms.\n\nShell state (cwd, env vars) persists for subsequent calls."
  );
  expect(
    formatShellCompletedResult({
      exitCode: 0,
      elapsedMs: 5,
      outputLocation: { filePath: "/workspace/.openteam/agent-tools/uuid.txt", sizeBytes: 51_200, lineCount: 1200 },
      workingDirectory: "/workspace/sub",
    })
  ).toBe(
    "Exit code: 0\n\nCommand output has been written to: /workspace/.openteam/agent-tools/uuid.txt (50.0 KB, 1200 lines)\n\nCommand completed in 5 ms.\n\nShell state (cwd, env vars) persists for subsequent calls. Current directory: /workspace/sub"
  );
  expect(formatShellCompletedResult({ exitCode: 0, elapsedMs: 1, output: truncateShellOutput("x".repeat(20_001)) })).toContain(
    "Command output (truncated to 20000 characters):\n\n```\n"
  );
  expect(formatInterruptedShellResult(4100, truncateShellOutput("part\n"))).toBe(
    "Error: Shell command was interrupted by the user after 4100ms before it completed.\n\nOutput collected before interruption:\n\n```\npart\n\n```"
  );
  expect(formatInterruptedShellResult(12, truncateShellOutput(""))).toBe(
    "Error: Shell command was interrupted by the user after 12ms before it completed."
  );
});

test("backgrounded results keep the output collected so far", () => {
  const common = { shellId: "123456", pid: 4242, outputPath: "/t/123456.log" };
  expect(formatShellBackgroundedResult({ ...common, intro: shellTimedOutIntro(30_000), partial: truncateShellOutput("starting\n") })).toBe(
    "The command did not complete in 30000ms and was sent to the background.\nShell ID: 123456\nPID: 4242\nThe output is being written to /t/123456.log. Don't mention Shell ID to the user.\n\nOutput collected before backgrounding:\n\n```\nstarting\n\n```"
  );
  expect(formatShellBackgroundedResult({ ...common, intro: shellUserBackgroundedIntro(4100), partial: truncateShellOutput("") })).toBe(
    "The user manually backgrounded the command after 4100ms. Do NOT await it; either continue with other work or end your turn.\nShell ID: 123456\nPID: 4242\nThe output is being written to /t/123456.log. Don't mention Shell ID to the user.\n\nNo output was collected before backgrounding."
  );
  expect(formatShellBackgroundedResult({ ...common, intro: shellTimedOutIntro(1), partial: truncateShellOutput("z".repeat(20_001)) })).toContain(
    "Output collected before backgrounding (truncated):\n\n```\n"
  );
  expect(formatShellStartedResult({ ...common, command: "npm test" })).toBe(
    "Background command started successfully.\nShell ID: 123456\nPID: 4242\nCommand: npm test\nOutput will be written to /t/123456.log. Don't mention Shell ID to the user."
  );
});

test("terminal frontmatter and footer match the reference layout", () => {
  const header = terminalFrontmatter({
    pid: 4242,
    cwd: "/workspace",
    command: 'echo "a"\nnext',
    status: "running",
    startedAt: "2026-10-20T21:00:00.000Z",
    runningForMs: 5003,
  });
  expect(header).toBe(
    '---\npid: 4242\ncwd: "/workspace"\ncommand: "echo \\"a\\"\\nnext"\nstatus: running  \nstarted_at: 2026-10-20T21:00:00.000Z\nrunning_for_ms: 5003     \n---\n'
  );
  const finished = terminalFrontmatter({ pid: 4242, cwd: "/workspace", command: 'echo "a"\nnext', status: "succeeded", startedAt: "2026-10-20T21:00:00.000Z", runningForMs: 123456789 });
  expect(Buffer.byteLength(finished)).toBe(Buffer.byteLength(header));
  expect(terminalFrontmatter({ cwd: "/w", command: "x", title: "Run tests", status: "failed", startedAt: "t", runningForMs: 0 })).toContain('command: "x"\ntitle: "Run tests"\nstatus: failed   \n');
  const footer = terminalFooter(1, 2013, new Date("2026-10-20T21:00:02.013Z"));
  expect(footer).toBe("\n---\nexit_code: 1\nelapsed_ms: 2013\nended_at: 2026-10-20T21:00:02.013Z\n---\n");
  expect(`out\n${footer}`.match(TERMINAL_FOOTER)?.slice(1)).toEqual(["1", "2013"]);
  expect(terminalFooter(null, 7).match(TERMINAL_FOOTER)?.[1]).toBe("unknown");
});
