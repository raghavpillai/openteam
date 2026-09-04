import { resolve } from "node:path";
import { numberText } from "../../../apps/desktop/src/main/host/jobs";

const arm = process.argv[2];
const linePairs = 5_242_880;

if (arm === "legacy" || arm === "bounded") {
  Bun.gc(true);
  const raw = "x\n".repeat(linePairs);
  Bun.gc(true);
  const rssBefore = process.memoryUsage.rss();
  const startedAt = performance.now();
  let output: string;
  let lines: number;
  if (arm === "legacy") {
    const split = raw.split(/\r?\n/);
    const numbered = split.map((line, index) => `${index + 1}: ${line}`).join("\n");
    output = numbered.length <= 100_000 ? numbered : `${numbered.slice(0, 100_000)}\n… truncated`;
    lines = split.length;
  } else {
    const result = numberText(raw, undefined, undefined);
    output = result.text;
    lines = result.lines;
  }
  const elapsedMs = performance.now() - startedAt;
  const rssAfter = process.memoryUsage.rss();
  console.log(
    JSON.stringify({
      arm,
      inputBytes: Buffer.byteLength(raw),
      lines,
      outputBytes: Buffer.byteLength(output),
      elapsedMs,
      rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
      rssAfterBytes: rssAfter,
    })
  );
  process.exit(0);
}

const script = resolve(import.meta.filename);
for (const name of ["legacy", "bounded"]) {
  const child = Bun.spawn([process.execPath, script, name], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`${name} benchmark failed (${code})`);
  console.log(stdout.trim());
}
