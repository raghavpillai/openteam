import { expect, test } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { captureDesktop } from "../src/screen/capture";
import { assignAgentOwnership } from "../src/agent-process";
import { tempDirs } from "./temp";
const tempDir = tempDirs();

test("desktop captures time out and release the actual capture process", async () => {
  const dir = await tempDir("screen-capture-");
  await writeFile(join(dir, "import"), `#!/bin/sh\necho $$ > '${dir}/pid'\nexec /bin/sleep 30\n`, {mode: 0o755});
  await assignAgentOwnership([dir], true);
  const started = Date.now();
  await expect(captureDesktop(105, {...process.env, PATH: dir}, undefined, 1_000)).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(3_000);
  const pid = Number(await readFile(join(dir, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("caller cancellation stops capture before its deadline and prevents pre-aborted capture", async () => {
  const dir = await tempDir("screen-capture-abort-");
  await writeFile(join(dir, "import"), "#!/bin/sh\nexec /bin/sleep 30\n", {mode: 0o755});
  await assignAgentOwnership([dir], true);
  const controller = new AbortController();
  const pending = captureDesktop(106, {...process.env, PATH: dir}, controller.signal);
  controller.abort(new Error("capture cancelled"));
  await expect(pending).rejects.toThrow("capture cancelled");
  await expect(captureDesktop(106, {...process.env, PATH: dir}, controller.signal)).rejects.toThrow("capture cancelled");
});

test("successful desktop capture preserves returned image bytes", async () => {
  const dir = await tempDir("screen-capture-success-");
  await writeFile(join(dir, "import"), "#!/bin/sh\nprintf '\\211PNG\\r\\n\\032\\n'\n", {mode: 0o755});
  await assignAgentOwnership([dir], true);
  expect(await captureDesktop(107, {...process.env, PATH: dir})).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
});
