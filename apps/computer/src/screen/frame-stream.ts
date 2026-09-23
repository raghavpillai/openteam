import { spawnAgentProcess as spawn, agentProcessIdentity } from "../agent-process";
import { environment, removeProcess } from "./processes";
import type { ScreenSession } from "./types";

export const FRAME_STREAM_CONTENT_TYPE = "multipart/x-mixed-replace; boundary=openteam-frame";
const viewers = new WeakMap<ScreenSession, number>();

/** One encoder per viewer, with bounded pipe backpressure and cancellation. */
export async function streamScreenFrames(
  home: string,
  session: ScreenSession,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  signal.throwIfAborted();
  if ((viewers.get(session) ?? 0) >= 3) throw new Error("Too many active computer viewers");
  viewers.set(session, (viewers.get(session) ?? 0) + 1);
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "x11grab",
      "-framerate",
      "15",
      "-video_size",
      `${session.width ?? 1280}x${session.height ?? 800}`,
      "-i",
      `:${session.display}`,
      "-an",
      "-c:v",
      "mjpeg",
      "-threads",
      "1",
      "-q:v",
      "5",
      "-f",
      "mpjpeg",
      "-boundary_tag",
      "openteam-frame",
      "pipe:1",
    ],
    {
      env: environment(home, session),
      ...agentProcessIdentity(),
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  session.processes.push(child);
  let closed = false;
  let failure: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (closed) return;
    closed = true;
    child.stdout.destroy();
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    killTimer.unref();
  };
  child.once("error", () => {
    failure = new Error("Computer video encoder could not start");
    child.stdout.destroy(failure);
  });
  child.once("close", (code) => {
    clearTimeout(killTimer);
    signal.removeEventListener("abort", stop);
    removeProcess(session, child);
    viewers.set(session, Math.max(0, (viewers.get(session) ?? 1) - 1));
    if (!closed && code !== 0) failure = new Error("Computer video encoder stopped");
  });
  signal.addEventListener("abort", stop, { once: true });
  const iterator = child.stdout[Symbol.asyncIterator]();
  const startupTimer = setTimeout(stop, 15_000);
  let first: IteratorResult<Buffer>;
  try {
    first = await iterator.next();
    signal.throwIfAborted();
    if (first.done || closed) throw failure ?? new Error("Computer video did not start");
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  let initial: Uint8Array | undefined = first.value;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (initial) {
            controller.enqueue(initial);
            initial = undefined;
            return;
          }
          const next = await iterator.next();
          if (next.done) {
            if (failure) throw failure;
            controller.close();
            stop();
          } else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          stop();
        }
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: 1 }
  );
}
