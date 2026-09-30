import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("textarea snapshots preserve line boundaries with bounded, redacted values", async () => {
  const root = await mkdtemp(join(tmpdir(), "textarea-snapshot-"));
  const server = Bun.serve({ port: 0, fetch: () => new Response('<textarea aria-label="Multiline"></textarea><textarea aria-label="Long"></textarea><textarea aria-label="Private" data-sand-secret-filled></textarea><textarea aria-label="Registered"></textarea>', { headers: { "content-type": "text/html" } }) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE });
  const context = await browser.newContext();
  const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
  const text = (r: any): string => r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join('\n');
  try {
    await session.execute('browser_navigate', { url: server.url.origin });
    const page = await (session as any).ensurePage();
    const value = 'First  line\n\nCafé 東京\nFinal line with enough text to exceed forty characters';
    await page.getByLabel('Multiline').fill(value);
    await page.getByLabel('Long', { exact: true }).fill('x'.repeat(2100));
    await page.getByLabel('Private', { exact: true }).fill('synthetic private text\nsecond line');
    session.registerPrivateValues(['registered-secret-fixture']);
    await page.getByLabel('Registered', { exact: true }).fill('registered-secret-fixture');
    const snapshot = text(await session.execute('browser_snapshot', {}));
    expect(snapshot).toContain('value=' + JSON.stringify(value));
    expect(snapshot).toContain('value=' + JSON.stringify('x'.repeat(2000)) + ' value-truncated');
    expect(snapshot).not.toContain('x'.repeat(2001));
    expect(snapshot).not.toContain('synthetic private text');
    expect(snapshot).not.toContain('registered-secret-fixture');
    expect(snapshot).toContain('value="<redacted>"');
    expect(snapshot).toContain('value="[REDACTED]"');
  } finally { await browser.close(); await driver.stop(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);
