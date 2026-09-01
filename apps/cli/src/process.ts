import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
  input?: string;
  inputFile?: string;
  outputFile?: string;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): RunResult;
}

export class SystemCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
    const output = options.outputFile ? openSync(options.outputFile, "w", 0o600) : null;
    const input = options.inputFile ? openSync(options.inputFile, "r") : null;
    try {
      const result = spawnSync(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: "utf8",
        shell: false,
        input: options.input,
        stdio: options.inherit
          ? [input ?? (options.input === undefined ? "inherit" : "pipe"), "inherit", "inherit"]
          : options.outputFile
            ? [input ?? (options.input === undefined ? "ignore" : "pipe"), output as number, "pipe"]
            : input
              ? [input, "pipe", "pipe"]
              : "pipe",
      });
      return {
        status: result.status ?? 1,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        error: result.error,
      };
    } finally {
      if (output !== null) closeSync(output);
      if (input !== null) closeSync(input);
    }
  }
}
