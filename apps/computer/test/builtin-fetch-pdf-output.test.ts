import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinFetch, MAX_WEB_DOWNLOAD, type publicWebGet } from "../src/builtin-fetch";

// Exercise the real child-process boundary with a controlled extractor. The
// input bytes are only a dispatch marker, not a PDF parser correctness fixture.
async function withExtractorOutput(size: number, run: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fetch-pdf-output-"));
  const originalPath = process.env.PATH;
  try {
    await chmod(dir, 0o755);
    await writeFile(join(dir, "pdftotext"), `#!/usr/bin/env python3\nimport sys\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(b'x' * ${size})\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath ?? "/usr/bin:/bin"}`;
    await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}
const url = "https://example.com/report.pdf";
const get = (async () => ({ url, bytes: Buffer.from("%PDF-extractor-test"), contentType: "application/pdf" })) as typeof publicWebGet;

test("PDF extraction refuses silent text truncation at its output limit", async () => {
  await withExtractorOutput(MAX_WEB_DOWNLOAD + 1, async () => {
    await expect(builtinFetch(url, undefined, get)).rejects.toThrow(/PDF.*text.*limit.*download/i);
  });
});

test("PDF extraction preserves complete output at the limit", async () => {
  await withExtractorOutput(MAX_WEB_DOWNLOAD, async () => {
    const result = await builtinFetch(url, undefined, get);
    expect(result.text.length).toBe(MAX_WEB_DOWNLOAD);
    expect(result.text.endsWith("x")).toBe(true);
  });
});
