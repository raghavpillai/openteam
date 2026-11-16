import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright, type OutOfProcessPlaywright } from "../../src/browser/playwright-driver";
import { prepareDownloadPreferences } from "../../src/browser/download-preferences";
import type { BrowserContext } from "playwright-core";

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html", ...headers } });

describe.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("browser_run_code contract on real Chromium", () => {
  let root: string, workspace: string, downloads: string, origin: string, endpoint: string;
  let server: ReturnType<typeof Bun.serve>, driver: OutOfProcessPlaywright, chrome: BrowserContext, session: BrowserUseSession;
  const raw = (code: string) => session.execute("browser_run_code", { code });
  const run = async (code: string) => JSON.parse(((await raw(code)).content[0] as { text: string }).text);
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

  });
