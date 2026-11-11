import { expect, test } from "bun:test";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createShellEnvironmentCapture } from "../src/environment";

test("capture cleanup never closes an unrelated file that reused its descriptor number", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-capture-descriptor-"));
  const capture = createShellEnvironmentCapture(root);
  // Bun can close an inherited numeric descriptor during spawn. Another asynchronous file open
  // may reuse that number before the command completes and its parent runs cleanup.
  closeSync(capture.fd);
  const unrelated = openSync(join(root, "unrelated"), "wx", 0o600);
  try {
    expect(unrelated).toBe(capture.fd);
    capture.closeParent();
    expect(() => writeSync(unrelated, "keep")).not.toThrow();
    expect(() => capture.closeParent()).not.toThrow();
  } finally {
    try { closeSync(unrelated); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
