import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDesktop } from "../src/screen/capture";
import { assignAgentOwnership } from "../src/agent-process";

test("desktop captures time out and release the actual capture process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screen-capture-"));
  try {
    await writeFile(join(dir, "import"), `#!/bin/sh\necho $$ > '${dir}/pid'\nexec /bin/sleep 30\n`, {mode: 0o755});
    await assignAgentOwnership([dir], true);
    const started = Date.now();
    await expect(captureDesktop(105, {...process.env, PATH: dir}, undefined, 1_000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("caller cancellation stops capture before its deadline and prevents pre-aborted capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screen-capture-abort-"));
  try {
    await writeFile(join(dir, "import"), "#!/bin/sh\nexec /bin/sleep 30\n", {mode: 0o755});
    await assignAgentOwnership([dir], true);
    const controller = new AbortController();
    const pending = captureDesktop(106, {...process.env, PATH: dir}, controller.signal);
    controller.abort(new Error("capture cancelled"));
    await expect(pending).rejects.toThrow("capture cancelled");
    await expect(captureDesktop(106, {...process.env, PATH: dir}, controller.signal)).rejects.toThrow("capture cancelled");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("successful desktop capture preserves returned image bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screen-capture-success-"));
  try {
    await writeFile(join(dir, "import"), "#!/bin/sh\nprintf '\\211PNG\\r\\n\\032\\n'\n", {mode: 0o755});
    await assignAgentOwnership([dir], true);
    expect(await captureDesktop(107, {...process.env, PATH: dir})).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  } finally { await rm(dir, {recursive: true, force: true}); }
});
