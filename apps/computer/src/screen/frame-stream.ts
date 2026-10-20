import { spawnAgentProcess as spawn, agentProcessIdentity } from "../agent-process";
import { environment, removeProcess } from "./processes";
import type { ScreenSession } from "./types";

export const FRAME_STREAM_CONTENT_TYPE = "multipart/x-mixed-replace; boundary=openteam-frame";
type Subscriber = { next?: Buffer; wake?: () => void; closed: boolean; error?: Error };
type Feed = { subscribers: Set<Subscriber>; latest?: Buffer; stopped: boolean; stop: () => void };
const feeds = new WeakMap<ScreenSession, Feed>();

/** Share complete frames; slow viewers retain only the newest frame. */
export async function streamScreenFrames(
  home: string,
  session: ScreenSession,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  signal.throwIfAborted();
  let feed = feeds.get(session);
  if (feed && feed.subscribers.size >= 3) throw new Error("Too many active computer viewers");
  if (!feed || feed.stopped) {
    feed = startFeed(home, session);
    feeds.set(session, feed);
  }
  const current = feed;
  const subscriber: Subscriber = { next: current.latest, closed: false };
  current.subscribers.add(subscriber);
  const unsubscribe = () => {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.next = undefined;
    signal.removeEventListener("abort", abort);
    current.subscribers.delete(subscriber);
    subscriber.wake?.();
    subscriber.wake = undefined;
    if (!current.subscribers.size) current.stop();
  };
  const abort = () => {
    subscriber.error =
      signal.reason instanceof Error ? signal.reason : new Error("Computer video cancelled");
    unsubscribe();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const waitForFrame = async () => {
    while (!subscriber.next && !subscriber.closed && !subscriber.error) {
      await new Promise<void>((resolve) => {
        subscriber.wake = resolve;
      });
      subscriber.wake = undefined;
    }
    if (subscriber.error) throw subscriber.error;
  };
  try {
    await waitForFrame();
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          await waitForFrame();
          if (subscriber.closed) {
            controller.close();
            return;
          }
          const frame = subscriber.next!;
          subscriber.next = undefined;
          controller.enqueue(frame);
        } catch (error) {
          controller.error(error);
          unsubscribe();
        }
      },
      cancel: unsubscribe,
    },
    { highWaterMark: 0 }
  );
}

function startFeed(home: string, session: ScreenSession): Feed {
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
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const feed: Feed = {
    subscribers: new Set(),
    stopped: false,
    stop() {
      if (feed.stopped) return;
      feed.stopped = true;
      if (feeds.get(session) === feed) feeds.delete(session);
      feed.latest = undefined;
      clearTimeout(startupTimer);
      child.stdout.destroy();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
    },
  };
  const fail = (error: Error) => {
    for (const subscriber of feed.subscribers) {
      subscriber.next = undefined;
      subscriber.error = error;
      subscriber.wake?.();
    }
    feed.stop();
  };
  const startupTimer = setTimeout(() => fail(new Error("Computer video did not start")), 15_000);
  child.once("error", () => fail(new Error("Computer video encoder could not start")));
  child.once("close", () => {
    clearTimeout(killTimer);
    clearTimeout(startupTimer);
    removeProcess(session, child);
    if (!feed.stopped) fail(new Error("Computer video encoder stopped"));
  });
  void (async () => {
    let pending: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout) {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const headerEnd = pending.indexOf("\r\n\r\n");
          if (headerEnd < 0) {
            if (pending.length > 4096) throw new Error("Invalid computer video header");
            break;
          }
          const length = Number(
            /Content-length:\s*(\d+)/i.exec(pending.subarray(0, headerEnd).toString("ascii"))?.[1]
          );
          if (!Number.isSafeInteger(length) || length < 4 || length > 32 * 1024 * 1024)
            throw new Error("Invalid computer video frame length");
          const end = headerEnd + 4 + length;
          if (pending.length < end) break;
          const jpeg = pending.subarray(headerEnd + 4, end);
          if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217)
            throw new Error("Invalid computer video JPEG");
          const frame = Buffer.concat([
            Buffer.from(
              `--openteam-frame\r\nContent-type: image/jpeg\r\nContent-length: ${length}\r\n\r\n`
            ),
            jpeg,
            Buffer.from("\r\n"),
          ]);
          pending = pending.subarray(end);
          clearTimeout(startupTimer);
          feed.latest = frame;
          for (const subscriber of feed.subscribers) {
            subscriber.next = frame;
            subscriber.wake?.();
          }
        }
      }
    } catch (error) {
      if (!feed.stopped) fail(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return feed;
}
