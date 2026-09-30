import { run } from "./processes";

/** Bound the capture process independently of desktop startup or input work. */
export async function captureDesktop(display: number, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 10_000): Promise<Buffer> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  return run("import", ["-display", `:${display}`, "-window", "root", "png:-"], {
    env,
    captureStdout: true,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
}
