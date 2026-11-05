import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamScreenFrames } from "../src/screen/frame-stream";
import type { ScreenSession } from "../src/screen/types";

let root: string | undefined;
let originalPath: string | undefined;
let session: ScreenSession | undefined;
const aborts: AbortController[] = [];
afterEach(async () => {
  for (const controller of aborts.splice(0)) controller.abort();
  for (const child of session?.processes ?? []) child.kill();
  if (originalPath !== undefined) process.env.PATH = originalPath;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  session = undefined;
});

const fixture = async () => {
  root = await mkdtemp(join(tmpdir(), "openteam-shared-video-"));
  const writer = join(root, "writer.ts");
  // Transport fixture only; actual JPEG decoding is covered by the desktop integration test.
  await writeFile(
    writer,
    `const frame=Buffer.concat([Buffer.from('--openteam-frame\\r\\nContent-type: image/jpeg\\r\\nContent-length: 4\\r\\n\\r\\n'),Buffer.from([255,216,255,217]),Buffer.from('\\r\\n')]);setTimeout(()=>{setInterval(()=>process.stdout.write(frame),25)},150);`
  );
  await writeFile(join(root, "ffmpeg"), `#!/bin/sh\nexec '${process.execPath}' '${writer}'\n`);
  await chmod(join(root, "ffmpeg"), 0o755);
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${root}:${originalPath}`;
  session = { display: 101, runtimeDirectory: root, processes: [] } as unknown as ScreenSession;
  return {
    open: (controller = new AbortController()) => {
      aborts.push(controller);
      return streamScreenFrames(root!, session!, controller.signal);
    },
    children: () => session!.processes.length,
    waitForCleanup: async () => {
      for (let i = 0; i < 100 && session!.processes.length; i++) await Bun.sleep(10);
      expect(session!.processes).toHaveLength(0);
    },
  };
};

test("cancelling one pending startup preserves the other viewer", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const cancelled = f.open(controller);
  const survivor = f.open();
  controller.abort(new Error("cancelled during startup"));
  await expect(cancelled).rejects.toThrow("cancelled during startup");
  const reader = (await survivor).getReader();
  expect((await reader.read()).done).toBe(false);
  expect(f.children()).toBe(1);
  await reader.cancel();
  await f.waitForCleanup();
});

test("encoder failure reaches subscribers and a new viewer can recover", async () => {
  const f = await fixture();
  const reader = (await f.open()).getReader();
  await reader.read();
  session!.processes[0]!.kill("SIGKILL");
  await Bun.sleep(100);
  await expect(reader.read()).rejects.toThrow("encoder stopped");
  await reader.cancel().catch(() => undefined);
  await f.waitForCleanup();
  const recovered = (await f.open()).getReader();
  expect((await recovered.read()).done).toBe(false);
  await recovered.cancel();
  await f.waitForCleanup();
});
