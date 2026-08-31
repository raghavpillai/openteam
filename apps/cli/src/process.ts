import { spawnSync } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
  input?: string;
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
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      shell: false,
      input: options.input,
      stdio: options.inherit
        ? [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"]
        : "pipe",
    });
    return {
      status: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      error: result.error,
    };
  }
}
