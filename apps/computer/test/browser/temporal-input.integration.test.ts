import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

// Isolated fixture: no user profile or live browser connection.
test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("temporal controls identify their type and recover from unsupported typing through fill", async () => {
  const root = await mkdtemp(join(tmpdir(), "temporal-input-"));
  const kinds = ["date", "time", "month", "datetime-local"];
  const values = ["2027-04-19", "16:45", "2027-04", "2027-04-19T16:45"];
  const server = Bun.serve({ port: 0, fetch: () => new Response(
    '<!doctype html><title>Temporal controls</title>' + kinds.map(kind => `<input type="${kind}" aria-label="${kind}">`).join('') + '<input type="date" readonly aria-label="locked" value="2020-01-01">',
    { headers: { "content-type": "text/html" } }) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE });
  const context = await browser.newContext();
  const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
  const text = (r: any): string => r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join('\n');
  try {
    const snapshot = text(await session.execute("browser_navigate", { url: `http://127.0.0.1:${server.port}` }));
    const ref = (name: string) => snapshot.split('\n').find(line => line.includes(`"${name}"`) && line.includes('[ref='))!.match(/\[ref=(e\d+)\]/)![1]!;
    const page = await (session as any).ensurePage();
    for (const [i, kind] of kinds.entries()) {
      expect(snapshot).toContain(`input-type=${kind}`);
      await expect(session.execute("browser_type", { ref: ref(kind), text: values[i], clear: true })).rejects.toThrow("browser_fill");
      expect(await page.getByLabel(kind, { exact: true }).inputValue()).toBe('');
      const result = await session.execute("browser_fill_form", { fields: [{ target: ref(kind), name: kind, type: "textbox", value: values[i] }] });
      expect((result as any).isError).toBe(false);
      expect(await page.getByLabel(kind, { exact: true }).inputValue()).toBe(values[i]);
    }
    await expect(session.execute("browser_type", { ref: ref('locked'), text: '2030-01-01' })).rejects.toThrow('not an enabled');
    expect(await page.getByLabel('locked').inputValue()).toBe('2020-01-01');
  } finally { await browser.close(); await driver.stop(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);
