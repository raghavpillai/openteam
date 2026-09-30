import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveLargeBrowserOutput } from "../../src/browser/output";
import { BrowserUseSession } from "../../src/browser/use";
const directories: string[] = [];
async function directory() { const p = await mkdtemp(join(tmpdir(), "browser-output-")); directories.push(p); return p; }
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
test("full Unicode results remain retrievable, small observations and images remain inline", async () => {
  const dir = await directory();
  const text = "prefix\n" + "🧭 café <track-list>\n".repeat(8000) + "TAIL-EVIDENCE";
  const image = { type: "image" as const, data: "fixture", mimeType: "image/png" };
  const result = await saveLargeBrowserOutput({ content: [{ type: "text", text }, image, { type: "text", text: "small" }], details: { viewId: "view-2" } }, dir);
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  expect(await readFile(join(dir, files[0]!), "utf8")).toBe(text);
  expect(JSON.stringify(result.content)).not.toContain("TAIL-EVIDENCE");
  expect(JSON.stringify(result.content)).not.toContain("�");
  expect(result.content[1]).toEqual(image);
  expect(result.content[2]).toEqual({ type: "text", text: "small" });
  expect(result.details.viewId).toBe("view-2");
});
test("storage failure preserves completed action result; concurrent outputs do not overwrite", async () => {
  const dir = await directory();
  const result = { content: [{ type: "text" as const, text: "x".repeat(110000) }], details: {} };
  const blocked = join(dir, "not-directory"); await writeFile(blocked, "existing");
  expect(await saveLargeBrowserOutput(result, blocked)).toEqual(result);
  await Promise.all(Array.from({ length: 4 }, () => saveLargeBrowserOutput(result, dir)));
  expect((await readdir(dir)).filter(x => x.endsWith(".txt"))).toHaveLength(4);
});
test("browser execution redacts before persisting complete large results", async () => {
  const dir = await directory();
  const session = new (BrowserUseSession as any)({}, { on() {} }, dir);
  session.registerPrivateValues(["fixture-private-value"]);
  session.executeWithDialogs = async () => ({ content: [{ type: "text", text: "fixture-private-value\n" + "observation\n".repeat(12000) + "fixture-private-value" }], details: {} });
  const result = await session.execute("browser_snapshot", {});
  expect(JSON.stringify(result)).not.toContain("fixture-private-value");
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  const saved = await readFile(join(dir, files[0]!), "utf8");
  expect(saved).not.toContain("fixture-private-value");
  expect(saved).toContain("observation");
});
