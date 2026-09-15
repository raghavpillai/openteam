import { spawn } from "node:child_process";
export type NativeCommand = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;
export const nativeCommand: NativeCommand = (file, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    const output: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        exceeded = true;
        child.kill();
      } else output.push(chunk);
    });
    // Drain stderr privately. Child errors can contain secrets and must not become tool output.
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timeout);
      reject(
        new Error("Native operation could not start; check the application and its OS permissions")
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || exceeded)
        reject(
          new Error(
            `Native operation failed (${code ?? "interrupted"}); check the application's OS permissions and connection`
          )
        );
      else resolve(Buffer.concat(output).toString("utf8"));
    });
  });
export const sqlText = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
export async function sqliteRows(
  run: NativeCommand,
  path: string,
  query: string,
  signal?: AbortSignal
): Promise<Array<Record<string, any>>> {
  return JSON.parse(
    (
      await run(
        "/usr/bin/sqlite3",
        ["-batch", "-init", "/dev/null", "-readonly", "-json", path, query],
        signal
      )
    ).trim() || "[]"
  );
}
