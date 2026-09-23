import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("snapshots expose native dropdown choices and current selections without JavaScript inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "select-snapshot-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html>
    <label>Priority <select id="priority"><option>One</option><option selected>Two</option><option disabled>Three</option><option hidden>Hidden choice</option></select></label>
    <label>Languages <select multiple><optgroup label="Available"><option selected>Café</option><option selected>日本語</option></optgroup><optgroup label="Unavailable" disabled><option>Latin</option></optgroup><optgroup label="Hidden" hidden><option>Invisible</option></optgroup></select></label>
    <select aria-label="Hidden control" hidden><option>Never visible</option></select>
    <select aria-label="Private choice" data-sand-secret-filled><option selected>private-value</option></select>
    <button>Submit</button>`, { headers: { "content-type": "text/html; charset=utf-8" } }) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  const session = new (BrowserUseSession as any)(browser, await browser.newContext(), root) as BrowserUseSession;
  const text = (result: any): string => result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  try {
    await session.execute("browser_navigate", { url: server.url.origin });
    let snapshot = text(await session.execute("browser_snapshot", {}));
    expect(snapshot).toContain('- option "One"');
    expect(snapshot).toContain('- option "Two" selected');
    expect(snapshot).toContain('- option "Three" disabled');
    expect(snapshot).toContain('- option "Café" selected');
    expect(snapshot).toContain('- option "日本語" selected');
    expect(snapshot).toContain('- option "Latin" disabled');
    expect(snapshot).not.toMatch(/- option "(?:Hidden choice|Invisible|Never visible)"/);
    expect(snapshot).not.toContain("private-value");
    const ref = snapshot.split("\n").find(line => line.includes('combobox "Priority'))!.match(/\[ref=(e\d+)\]/)![1]!;
    await session.execute("browser_select_option", { ref, element: "Priority", values: ["One"] });
    snapshot = text(await session.execute("browser_snapshot", {}));
    expect(snapshot).toContain('- option "One" selected');
    expect(snapshot).not.toContain('- option "Two" selected');
    expect(snapshot.split("\n").find(line => line.includes('combobox "Priority'))).toContain(`[ref=${ref}]`);
    const shallow = text(await session.execute("browser_snapshot", { maxDepth: 0 }));
    expect(shallow).toContain('combobox "Priority');
    expect(shallow).not.toContain('- option "One"');
    const page = await (session as any).ensurePage();
    await page.setContent('<select aria-label="Large menu">' + Array.from({ length: 1000 }, (_, i) => `<option>Choice ${i}</option>`).join("") + '</select>');
    const bounded = text(await session.execute("browser_snapshot", {}));
    expect(bounded.match(/- option /g)?.length).toBeLessThanOrEqual(399);
    expect(bounded).toContain("snapshot truncated");
  } finally {
    await browser.close(); await driver.stop(); server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
