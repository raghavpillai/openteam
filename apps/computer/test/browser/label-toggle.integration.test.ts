import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUseSession } from '../../src/browser/use';
import { outOfProcessPlaywright } from '../../src/browser/playwright-driver';

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)('visible labels expose refs and checked state for styled native toggles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'label-toggle-'));
  const server = Bun.serve({ port: 0, fetch: () => new Response(`<!doctype html><style>input[type=radio]{display:none}</style>
    <input type="radio" name="period" id="short" checked><label for="short">Short period</label>
    <input type="radio" name="period" id="long"><label for="long">Long period</label>
    <input type="radio" id="locked" disabled><label for="locked">Unavailable</label>
    <label>Include extras<input type="checkbox"></label><label>Ordinary text</label>
    <label hidden><input type="checkbox">Hidden option</label>
    <label>Import CSV<input id="upload" type="file" style="display:none"></label>
    <input id="second-upload" type="file" style="display:none">
    <label for="second-upload">Second upload</label>
    <label>Disabled upload<input type="file" disabled style="display:none"></label>`, { headers: { 'content-type': 'text/html' } }) });
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({ headless: true, executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
  const session = new (BrowserUseSession as any)(browser, await browser.newContext(), root) as BrowserUseSession;
  const text = (r: any) => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  try {
    let snapshot = text(await session.execute('browser_navigate', { url: server.url.href }));
    const line = (name: string) => snapshot.split('\n').find((s: string) => s.includes(`label "${name}"`)) ?? '';
    expect(line('Short period')).toMatch(/\[ref=e\d+\].*checked/);
    const ref = line('Long period').match(/\[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeDefined();
    expect(line('Unavailable')).toContain('disabled');
    expect(line('Unavailable')).not.toContain('[ref=');
    expect(line('Ordinary text')).not.toContain('[ref=');
    expect(snapshot).not.toContain('Hidden option');
    expect(snapshot).toContain('checkbox "Include extras"');
    const uploadRef = line('Import CSV').match(/\[ref=(e\d+)\]/)?.[1];
    expect(uploadRef).toBeDefined();
    expect(line('Second upload')).toMatch(/\[ref=e\d+\]/);
    expect(line('Disabled upload')).toContain('disabled');
    expect(line('Disabled upload')).not.toContain('[ref=');
    const observed = await session.fileInputReviewTarget({ ref: uploadRef });
    expect(observed?.observation.target.type).toBe('file');
    await observed!.validate();
    const uploadPage = await (session as any).ensurePage();
    await uploadPage.locator('label').filter({hasText: 'Import CSV'}).evaluate((label: HTMLLabelElement) => label.htmlFor = 'second-upload');
    await expect(observed!.validate()).rejects.toThrow('changed');
    await observed!.dispose();
    await uploadPage.locator('label').filter({hasText: 'Import CSV'}).evaluate((label: HTMLLabelElement) => label.removeAttribute('for'));

    await session.execute('browser_click', { ref, element: 'Long period' });
    snapshot = text(await session.execute('browser_snapshot', {}));
    expect(line('Long period')).toContain('checked');
    expect(line('Short period')).not.toContain('checked');
    const page = await (session as any).ensurePage();
    expect(await page.locator('#long').isChecked()).toBe(true);
    snapshot = text(await session.execute('browser_snapshot', {}));
    const currentUploadRef = line('Import CSV').match(/\[ref=(e\d+)\]/)?.[1];
    const pickerEvent = page.waitForEvent('filechooser');
    await session.execute('browser_click', { ref: currentUploadRef, element: 'Import CSV' });
    const picker = await pickerEvent;
    expect(await picker.element().getAttribute('id')).toBe('upload');
    await picker.setFiles([]);
  } finally {
    await browser.close(); await driver.stop(); server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
