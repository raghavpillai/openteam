import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeShell,
  MAX_INLINE_BYTES,
  MAX_SHELL_LOG_BYTES,
} from "../../apps/desktop/src/main/host-jobs";

const directory = await mkdtemp(join(tmpdir(), "openteam-host-shell-benchmark-"));
let peakRss = process.memoryUsage.rss();
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 5);
try {
  const startedAt = performance.now();
  const result = await executeShell(
    {
      command: "yes x | head -c 134217728",
      working_directory: directory,
      block_until_ms: 60_000,
    },
    directory
  );
  const elapsedMs = performance.now() - startedAt;
  clearInterval(sample);
  const logBytes = (await stat(result.output_path)).size;
  console.log(
    JSON.stringify(
      {
        generatedBytes: 128 * 1024 * 1024,
        inlineBytes: Buffer.byteLength(result.output),
        inlineBudget: MAX_INLINE_BYTES,
        logBytes,
        logBudget: MAX_SHELL_LOG_BYTES,
        status: result.status,
        exitCode: result.exit_code,
        elapsedMs,
        peakRssBytes: peakRss,
      },
      null,
      2
    )
  );
} finally {
  clearInterval(sample);
  await rm(directory, { recursive: true, force: true });
}
