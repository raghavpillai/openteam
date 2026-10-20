import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright, type OutOfProcessPlaywright } from "../../src/browser/playwright-driver";
import { prepareDownloadPreferences } from "../../src/browser/download-preferences";
import { pdfPageCount, runBrowserCode } from "../../src/browser/run-code";
import type { BrowserContext } from "playwright-core";

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html", ...headers } });

describe.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("browser_run_code contract on real Chromium", () => {
  let root: string, workspace: string, downloads: string, origin: string, endpoint: string;
  let server: ReturnType<typeof Bun.serve>, driver: OutOfProcessPlaywright, chrome: BrowserContext, session: BrowserUseSession;
  const raw = (code: string) => session.execute("browser_run_code", { code });
  const run = async (code: string) => JSON.parse(((await raw(code)).content[0] as { text: string }).text);
  const refFor = (text: string, line: RegExp) => {
    const match = text.split("\n").find(entry => line.test(entry))?.match(/\[ref=(e\d+)\]/);
    if (!match) throw new Error(`No ref for ${line} in:\n${text}`);
    return match[1]!;
  };
  const snapshot = async () => ((await session.execute("browser_snapshot", {})).content[0] as { text: string }).text;
  const open = async (path = "/") => { await session.execute("browser_navigate", { url: origin + path }); };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "run-code-contract-"));
    workspace = join(root, "workspace");
    downloads = join(root, "Downloads");
    await mkdir(workspace, { recursive: true });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === "/inner") return html(`<button onclick="this.textContent='Inner clicked'">Inner button</button>`);
      if (url.pathname === "/cross") return html(`<button onclick="this.textContent='Cross clicked'">Cross button</button>`);
      if (url.pathname === "/report.txt") return new Response("report body", { headers: { "content-type": "text/plain", "content-disposition": `attachment; filename="${url.searchParams.get("name") ?? "report.txt"}"` } });
      if (url.pathname === "/slow-download") return new Response(new ReadableStream({ async pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        await Bun.sleep(200);
      } }), { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="slow.bin"' } });
      if (url.pathname === "/slow") { await Bun.sleep(6_000); return html("<title>Slow page</title><h1>Slow but loaded</h1>"); }
      if (url.pathname === "/json") return Response.json({ secret: "body" });
      if (url.pathname === "/post") return Response.json({ ok: true });
      return html(`<title>Contract</title>
        <form id="profile"><label>Name <input name="name" value="Ada"></label>
        <button type="button" onclick="document.querySelector('#out').textContent='Saved '+document.querySelector('[name=name]').value">Save</button></form>
        <div id="elsewhere"><button type="button" onclick="document.querySelector('#out').textContent='Other'">Other</button></div>
        <button type="button" id="rerender" onclick="const old=document.querySelector('#profile button');old.replaceWith(old.cloneNode(true))">Re-render</button>
        <input type="file" id="upload" multiple onchange="document.querySelector('#files').textContent=[...this.files].map(f=>f.name).join(',')">
        <input type="file" id="hidden-upload" style="display:none" onchange="document.querySelector('#files').textContent='hidden:'+this.files[0].name">
        <button type="button" id="choose" onclick="document.querySelector('#upload').click()">Choose file</button>
        <a id="download" href="/report.txt">Download report</a> <a id="fresh-download" href="/report.txt?name=fresh-report.txt">Fresh report</a> <a id="slow-download" href="/slow-download">Slow download</a>
        <button type="button" id="post" onclick="fetch('/post',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({_id:'record-7',__typename:'Listing',constructor:'ordinary field',price:42})})">Post</button>
        <output id="out"></output><output id="files"></output>
        <iframe src="/inner"></iframe><iframe src="http://localhost:${url.port}/cross"></iframe>`);
    } });
    origin = `http://127.0.0.1:${server.port}`;
    driver = await outOfProcessPlaywright();
    const profile = join(root, "profile");
    await prepareDownloadPreferences(profile, root);
    chrome = await driver.playwright.chromium.launchPersistentContext(profile, {
      executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE, headless: true, args: ["--remote-debugging-port=0"],
    });
    chrome.on("dialog", () => {});
    endpoint = `http://127.0.0.1:${(await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]}`;
    session = await BrowserUseSession.connect(endpoint, root, false, downloads);
    session.configureUploads(workspace);
  });
  afterAll(async () => {
    await chrome?.close(); await driver?.stop(); server?.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test("refs from browser_snapshot work as aria-ref locators across calls and tools until re-rendered", async () => {
    await open();
    const text = await snapshot();
    const save = refFor(text, /button "Save"/), name = refFor(text, /textbox "Name"/);
    const inner = refFor(text, /button "Inner button"/), cross = refFor(text, /button "Cross button"/);
    expect((await run(`async (page) => { await page.locator('aria-ref=${name}').fill('Grace'); await page.locator('aria-ref=${save}').click(); return page.locator('#out').innerText(); }`)).result).toBe("Saved Grace");
    // Chained under a container, and scoped out by the wrong one.
    expect((await run(`async (page) => [await page.locator('form >> aria-ref=${save}').count(), await page.locator('#elsewhere').locator('aria-ref=${save}').count(), await page.locator('#profile').locator('aria-ref=${name}').inputValue()]`)).result).toEqual([1, 0, "Grace"]);
    // Same-origin and cross-origin frame refs, from the page and from a frame locator.
    expect((await run(`async (page) => [await page.frameLocator('iframe').last().locator('aria-ref=${cross}').innerText(), await page.frameLocator('iframe').first().locator('aria-ref=${inner}').innerText()]`)).result).toEqual(["Cross button", "Inner button"]);
    // Clicking renames both buttons, which retires their refs as browser_snapshot documents.
    expect((await run(`async (page) => { await page.locator('aria-ref=${inner}').click(); await page.locator('aria-ref=${cross}').click();
      return [await page.frameLocator('iframe').first().getByRole('button').innerText(), await page.frameLocator('iframe').last().getByRole('button').innerText(), await page.locator('aria-ref=${cross}').count()]; }`)).result).toEqual(["Inner clicked", "Cross clicked", 0]);
    const staleFrame = await run(`async (page) => page.locator('aria-ref=${cross}').click({ timeout: 300 })`);
    expect(staleFrame.error.message).toContain(`locator('aria-ref=${cross}')`);
    expect(staleFrame.error.message).not.toContain("openteam-ref");
    // A later call, and the parent's own ref tools, still accept the same refs.
    expect((await run(`async (page) => page.locator('aria-ref=${save}').innerText()`)).result).toBe("Save");
    expect(JSON.stringify(await session.execute("browser_click", { target: save, element: "Save" }))).toContain("Saved Grace");
    await run(`async (page) => page.locator('#rerender').click()`);
    const stale = await run(`async (page) => page.locator('aria-ref=${save}').click({ timeout: 300 })`);
    expect(stale.error.code).toBe("job_failed");
    expect(stale.error.message).toContain(`aria-ref=${save}`);
    expect(stale.error.message).not.toContain("openteam-ref");
    expect(stale.error.message).toContain("fresh await page.ariaSnapshot");
    await expect(session.execute("browser_click", { target: save, element: "Save" })).rejects.toThrow();
  }, 60_000);

  test("page.ariaSnapshot({ mode: 'ai' }) mints refs shared with browser tools; other modes stay stock", async () => {
    await open();
    const result = await run(`async (page) => {
      const tree = await page.ariaSnapshot({ mode: 'ai' });
      const save = tree.match(/button "Save" \\[ref=(e\\d+)\\]/)[1];
      await page.locator('aria-ref=' + save).click();
      const form = await page.locator('#profile').ariaSnapshot({ mode: 'ai' });
      return { tree, form, save, out: await page.locator('#out').innerText(), plain: await page.ariaSnapshot(), plainForm: await page.locator('#profile').ariaSnapshot() };
    }`);
    expect(result.error).toBeUndefined();
    const { tree, form, save, out, plain, plainForm } = result.result;
    expect(tree).toContain('textbox "Name"');
    expect(tree).toContain('value="Ada"');
    expect(tree).toContain("Cross button");
    expect(out).toBe("Saved Ada");
    expect(form).toContain(`[ref=${save}]`);
    expect(form).not.toContain("Choose file");
    expect(plain).toContain('button "Save"');
    expect(plain).not.toContain("[ref=");
    expect(plainForm).not.toContain("[ref=");
    // Scoped snapshots reach same-origin frames; a cross-origin element says what to use instead.
    const framed = await run(`async (page) => page.frameLocator('iframe').first().getByRole('button').ariaSnapshot({ mode: 'ai' })`);
    expect(framed.result).toMatch(/button "Inner button" \[ref=e\d+\]/);
    expect(framed.result).not.toContain("Save");
    const crossScoped = await run(`async (page) => page.frameLocator('iframe').last().getByRole('button').ariaSnapshot({ mode: 'ai' })`);
    expect(crossScoped.error.code).toBe("job_failed");
    expect(crossScoped.error.message).toContain("use page.ariaSnapshot({ mode: 'ai' })");
    // The parent tools accept refs a script minted.
    const name = refFor(tree, /textbox "Name"/);
    expect(JSON.stringify(await session.execute("browser_type", { target: name, element: "Name", text: "Lin" }))).toContain("Lin");
    expect((await run(`async (page) => page.locator('aria-ref=${name}').inputValue()`)).result).toBe("Lin");
  }, 60_000);

  test("image Blobs return as named images, at most four, and PDF Blobs are saved to the workspace", async () => {
    await open();
    const shot = await raw(`async (page) => ({ title: await page.title(), after: new Blob([await page.screenshot()], { type: 'image/png' }) })`);
    const payload = JSON.parse((shot.content[0] as { text: string }).text);
    expect(payload.result.title).toBe("Contract");
    expect(payload.result.after).toMatch(/^<image after: image\/png, \d+ bytes>$/);
    expect(shot.content.slice(1).map(part => part.type)).toEqual(["text", "image"]);
    expect((shot.content[1] as { text: string }).text).toContain('"after"');
    expect(shot.content[2]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from((shot.content[2] as { data: string }).data, "base64").subarray(1, 4).toString()).toBe("PNG");
    const direct = await raw(`async (page) => new Blob([await page.screenshot({ type: 'jpeg' })])`);
    expect(direct.content.at(-1)).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect((direct.content[1] as { text: string }).text).toContain('"result"');
    const many = await raw(`async (page) => { const shot = await page.screenshot(); const out = {}; for (const key of ['a','b','c','d','e']) out[key] = new Blob([shot], { type: 'image/png' }); out.nested = { inner: new Blob(['x']) }; return out; }`);
    const manyPayload = JSON.parse((many.content[0] as { text: string }).text);
    expect(many.content.filter(part => part.type === "image")).toHaveLength(4);
    expect(manyPayload.result.e).toContain("at most 4 images");
    expect(manyPayload.result.nested.inner).toContain("top-level");
    const pdf = await run(`async (page) => ({ report: new Blob([await page.pdf()], { type: 'application/pdf' }), note: new Blob(['plain'], { type: 'text/plain' }) })`);
    expect(pdf.error).toBeUndefined();
    const { path, pages, bytes } = pdf.result.report;
    expect(path.startsWith(join(workspace, "browser-pdfs") + "/")).toBe(true);
    expect(path).toEndWith(".pdf");
    expect(pages).toBeGreaterThanOrEqual(1);
    expect((await stat(path)).size).toBe(bytes);
    expect(pdfPageCount(await readFile(path))).toBe(pages);
    expect(pdf.result.note).toContain("not a PNG, JPEG, GIF or WebP image or a PDF");
  }, 60_000);

  test("blocked APIs fail with policy_denied naming the API", async () => {
    await open();
    const blocked: Array<[string, string]> = [
      ["page.evaluate(() => 1)", "Page.evaluate"],
      ["page.locator('body').evaluate(node => node.tagName)", "Locator.evaluate"],
      ["page.evaluateHandle(() => document)", "Page.evaluateHandle"],
      ["page.$eval('body', node => node.tagName)", "Page.$eval"],
      ["page.$$eval('a', nodes => nodes.length)", "Page.$$eval"],
      ["page.locator('a').evaluateAll(nodes => nodes.length)", "Locator.evaluateAll"],
      ["page.waitForFunction(() => true)", "Page.waitForFunction"],
      ["page.addScriptTag({ content: 'window.x = 1' })", "Page.addScriptTag"],
      ["page.addInitScript(() => {})", "Page.addInitScript"],
      ["page.context().addInitScript(() => {})", "BrowserContext.addInitScript"],
      ["page.setContent('<p>replaced</p>')", "Page.setContent"],
      ["page.exposeFunction('probe', () => 1)", "Page.exposeFunction"],
      ["page.exposeBinding('probe', () => 1)", "Page.exposeBinding"],
      ["page.mainFrame().evaluate(() => 1)", "Frame.evaluate"],
      ["page.$('body')", "Page.$"],
      ["page.$$('a')", "Page.$$"],
      ["page.locator('body').elementHandle()", "Locator.elementHandle"],
      ["page.locator('a').elementHandles()", "Locator.elementHandles"],
      ["page.setViewportSize({ width: 300, height: 300 })", "Page.setViewportSize"],
      ["(await page.goto(page.url())).text()", "Response.text"],
      ["(await page.goto(page.url())).body()", "Response.body"],
      ["(await page.goto(page.url())).json()", "Response.json"],
      ["page.context().addCookies([{ name: 'a', value: 'b', url: page.url() }])", "BrowserContext.addCookies"],
      ["page.context().clearCookies()", "BrowserContext.clearCookies"],
      ["page.context().cookies()", "BrowserContext.cookies"],
      ["page.context().storageState()", "BrowserContext.storageState"],
      ["page.route('**/*', route => route.continue())", "Page.route"],
      ["page.unroute('**/*')", "Page.unroute"],
      ["page.context().route('**/*', route => route.continue())", "BrowserContext.route"],
      ["page.routeFromHAR('/tmp/none.har')", "Page.routeFromHAR"],
      ["page.request.get(page.url())", "Page.request"],
      ["page.context().request.get(page.url())", "BrowserContext.request"],
      ["page.coverage.startJSCoverage()", "Page.coverage"],
      ["(async () => { await using context = page.context(); })()", "BrowserContext.close"],
      ["page.screenshot({ path: '/tmp/shot.png' })", "Page.screenshot"],
      ["page.locator('body').screenshot({ path: '/tmp/shot.png' })", "Locator.screenshot"],
      ["page.pdf({ path: '/tmp/page.pdf' })", "Page.pdf"],
      ["page.context().tracing.start()", "BrowserContext.tracing"],
      ["page.context().browser()", "BrowserContext.browser"],
      ["page.context().newCDPSession(page)", "BrowserContext.newCDPSession"],
      ["page.goto('data:text/html,<p>hi</p>')", "Page.goto"],
      ["page.goto('file:///etc/hosts')", "Page.goto"],
      ["page.goto('javascript:alert(1)')", "Page.goto"],
      ["page.goto('chrome://version')", "Page.goto"],
      ["page.mainFrame().goto('data:text/html,hi')", "Frame.goto"],
      ["page._channel", "Page._channel"],
    ];
    for (const [call, api] of blocked) {
      const result = await run(`async (page) => { console.log('before'); return await ${call}; }`);
      expect(result.error?.code, call).toBe("policy_denied");
      expect(result.error.message, call).toContain(api);
      expect(result.stdio, call).toEqual([{ type: "log", text: "before" }]);
    }
    const saveAs = await run(`async (page) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#download')]); await d.saveAs('/tmp/report.txt'); }`);
    expect(saveAs.error).toMatchObject({ code: "policy_denied" });
    expect(saveAs.error.message).toContain("Download.saveAs");
    // Allowed neighbours keep working.
    expect((await run(`async (page) => { await page.goto('about:blank'); const blank = page.url(); await page.goto('${origin}/'); return [blank, await page.title()]; }`)).result).toEqual(["about:blank", "Contract"]);
    // Ordinary data fields named like internals survive; only browser handles are guarded.
    const posted = await run(`async (page) => { const [request] = await Promise.all([page.waitForRequest('**/post'), page.click('#post')]); return request.postDataJSON(); }`);
    expect(posted.result).toEqual({ _id: "record-7", __typename: "Listing", constructor: "ordinary field", price: 42 });
  }, 120_000);

  test("uploads accept workspace paths, in-memory files and a chooser from an earlier call", async () => {
    await open();
    const file = join(workspace, "sample.txt"), second = join(workspace, "second.txt");
    await writeFile(file, "synthetic upload"); await writeFile(second, "second upload");
    await writeFile(join(root, "outside.txt"), "outside");
    expect((await run(`async (page) => { await page.locator('#upload').setInputFiles(['${file}', '${second}']); return page.locator('#files').innerText(); }`)).result).toBe("sample.txt,second.txt");
    expect((await run(`async (page) => { await page.setInputFiles('#hidden-upload', '${file}'); return page.locator('#files').innerText(); }`)).result).toBe("hidden:sample.txt");
    expect((await run(`async (page) => { await page.locator('#upload').setInputFiles({ name: 'memory.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b') }); return page.locator('#files').innerText(); }`)).result).toBe("memory.csv");
    for (const path of [join(root, "outside.txt"), "sample.txt", `${workspace}/../outside.txt`]) {
      const denied = await run(`async (page) => page.locator('#upload').setInputFiles(${JSON.stringify(path)})`);
      expect(denied.error?.code, path).toBe("policy_denied");
      expect(denied.error.message).toContain("Locator.setInputFiles");
    }
    expect((await run(`async (page) => page.locator('#upload').setInputFiles('${join(workspace, "missing.txt")}')`)).error.code).toBe("job_failed");
    // A chooser handled inside the script leaves nothing pending for other tools.
    expect((await run(`async (page) => { const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#choose')]); await chooser.setFiles('${second}'); return page.locator('#files').innerText(); }`)).result).toBe("second.txt");
    expect((await run(`async (page, { fileChooser }) => fileChooser`)).result).toBeNull();
    const text = await snapshot();
    expect(JSON.stringify(await session.execute("browser_click", { target: refFor(text, /button "Save"/), element: "Save" }))).toContain("Saved");
    // A chooser an earlier call opened arrives as the second argument.
    await run(`async (page) => { await page.click('#choose'); return 'opened'; }`);
    expect((await run(`async (page, { fileChooser }) => { await fileChooser.setFiles(['${file}', '${second}']); return [fileChooser.isMultiple(), await fileChooser.page().title(), await page.locator('#files').innerText()]; }`)).result).toEqual([true, "Contract", "sample.txt,second.txt"]);
    expect((await run(`async (page, { fileChooser }) => fileChooser`)).result).toBeNull();
    await run(`async (page) => { await page.click('#choose'); return 'opened'; }`);
    const outside = await run(`async (page, { fileChooser }) => fileChooser.setFiles('${join(root, "outside.txt")}')`);
    expect(outside.error).toMatchObject({ code: "policy_denied" });
    expect((await run(`async (page, { fileChooser }) => { await fileChooser.setFiles({ name: 'chosen.txt', mimeType: 'text/plain', buffer: Buffer.from('in memory') }); return page.locator('#files').innerText(); }`)).result).toBe("chosen.txt");
  }, 60_000);

  test("downloads land in the Downloads folder under Chrome's names and outlive the script", async () => {
    await open();
    const first = await run(`async (page) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#fresh-download')]); return { path: await d.path(), failure: await d.failure(), name: d.suggestedFilename() }; }`);
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual({ path: join(downloads, "fresh-report.txt"), failure: null, name: "fresh-report.txt" });
    const again = await run(`async (page) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#fresh-download')]); return d.path(); }`);
    expect(again.result).toBe(join(downloads, "fresh-report (1).txt"));
    expect(await readFile(first.result.path, "utf8")).toBe("report body");
    expect(await readFile(again.result, "utf8")).toBe("report body");
    const canceled = await run(`async (page) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#slow-download')]); await d.cancel(); return d.failure(); }`);
    expect(canceled.result).toBe("canceled");
    expect(await readdir(downloads)).toContain("fresh-report.txt");
  }, 60_000);

  test("actions time out after 5 s unless given a timeout; navigation keeps 30 s; failures carry codes", async () => {
    await open();
    const started = Date.now();
    const missing = await run(`async (page) => { console.log('looking'); await page.locator('#missing').click(); }`);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(missing.error.code).toBe("job_failed");
    expect(missing.error.message).toContain("Timeout 5000ms exceeded");
    expect(missing.stdio).toEqual([{ type: "log", text: "looking" }]);
    expect((await run(`async (page) => page.locator('#missing').click({ timeout: 200 })`)).error.message).toContain("Timeout 200ms exceeded");
    expect((await run(`async (page) => { await page.goto('${origin}/slow'); return page.title(); }`)).result).toBe("Slow page");
    expect(await run(`async (page) => { throw new Error('intentional'); }`)).toEqual({ error: { code: "job_failed", message: "intentional" }, stdio: [] });
    // A call the script forgot to await fails the script with its own error, not as a crashed worker.
    const unawaited = await run(`async (page) => { page.locator('#missing').click({ timeout: 200 }); await page.waitForTimeout(3000); return 'done'; }`);
    expect(unawaited.error.code).toBe("job_failed");
    expect(unawaited.error.message).toContain("Timeout 200ms exceeded");
    expect((await run(`async (page) => page.title()`))).toEqual({ result: "Slow page", stdio: [] });
    expect((await run(`not a function at all`)).error.code).toBe("job_failed");
    expect((await run(`42`)).error.message).toContain("must be a function");
    const page = (session as any).leasedPages()[0];
    const target = await (session as any).targetFor(page);
    const hung = await runBrowserCode({ endpoint, targets: [target], selected: target, code: "async (page) => { console.log('started'); await new Promise(() => {}); }" }, undefined, 3_000);
    expect(hung.payload.error).toMatchObject({ code: "timed_out" });
    expect(hung.payload.stdio).toEqual([{ type: "log", text: "started" }]);
    const spinning = await runBrowserCode({ endpoint, targets: [target], selected: target, code: "async (page) => { while (true) {} }" }, undefined, 3_000);
    expect(spinning.payload.error?.code).toBe("timed_out");
    const unreachable = await runBrowserCode({ endpoint: "http://127.0.0.1:1", targets: [target], selected: target, code: "async (page) => 1" });
    expect(unreachable.payload.error?.code).toBe("worker_failed");
  }, 90_000);

  test("each call has a page and only the documented globals", async () => {
    const scope = await run(`async (page) => { globalThis.leak = 1; return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof expect, typeof Blob, typeof Buffer, typeof URL, typeof TextEncoder, typeof TextDecoder]; }`);
    expect(scope.result).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "function", "function", "function", "function", "function"]);
    expect((await run(`async (page) => typeof leak`)).result).toBe("undefined");
    // With every tab closed, the next call gets a new blank tab.
    await run(`async (page) => { for (const p of page.context().pages()) await p.close(); }`);
    expect((await run(`async (page) => [page.url(), page.context().pages().length]`)).result).toEqual(["about:blank", 1]);
    // A selected tab that disappeared before the script attached falls back too.
    const fresh = await runBrowserCode({ endpoint, targets: [], selected: "gone", code: "async (page) => page.url()" });
    expect(fresh.payload.result).toBe("about:blank");
    expect(fresh.targets).toHaveLength(1);
    expect(fresh.selected).toBe(fresh.targets[0]!);
  }, 60_000);
});
