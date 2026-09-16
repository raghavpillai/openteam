import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";

// Fresh browser, localhost page, synthetic credentials; never adopts user tabs.
test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)(
  "saved logins block direct and transformed CDP reads before protocol dispatch",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "private-cdp-fixture-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(
        '<!doctype html><title>Private CDP fixture</title><form><label>Username<input autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label></form>',
        { headers: { "content-type": "text/html" } }
      ),
    });
    const driver = await outOfProcessPlaywright();
    const browser = await driver.playwright.chromium.launch({
      headless: true,
      executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,
    });
    const context = await browser.newContext();
    const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
    try {
      await session.execute("browser_navigate", { url: server.url.origin });
      const ordinary = await session.execute("browser_cdp", {
        method: "Runtime.evaluate", params: { expression: "2+2", returnByValue: true },
      });
      expect((ordinary.details.result as any).result.value).toBe(4);

      const binding = await session.loginBinding(server.url.origin);
      try {
        expect(await session.fillSavedLogin(binding, {
          origin: server.url.origin, username: "fixture-user", password: "SYNTHETIC-cdp-secret-42",
        })).toBe(true);
      } finally { await session.releaseLoginBinding(binding); }

      const page = await (session as any).ensurePage();
      expect(await page.locator("#password").inputValue()).toBe("SYNTHETIC-cdp-secret-42");
      let protocolSessions = 0;
      const openSession = context.newCDPSession.bind(context);
      context.newCDPSession = async (target) => { protocolSessions++; return openSession(target); };
      const read = 'document.querySelector("#password").value';
      const transformations = [
        read,
        `btoa(${read})`,
        `Array.from(${read}, c => c.charCodeAt(0))`,
        `crypto.subtle.digest("SHA-256",new TextEncoder().encode(${read})).then(bytes=>Array.from(new Uint8Array(bytes)))`,
      ];
      const requests = [
        ...transformations.map(expression => ({ method: "Runtime.evaluate", params: {
          expression: `globalThis.__privateCdpAttempted = true; ${expression}`,
          returnByValue: true, awaitPromise: true,
        } })),
        { method: "Runtime.callFunctionOn", params: {
          functionDeclaration: `function(){globalThis.__privateCdpAttempted=true;return btoa(${read});}`,
          executionContextId: 1, returnByValue: true,
        } },
        { method: "DOM.getDocument", params: { depth: -1, pierce: true } },
        { method: "DOMSnapshot.captureSnapshot", params: { computedStyles: [] } },
        { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: `btoa(${read})` } },
        { method: "Network.getResponseBody", params: { requestId: "fixture" } },
      ];
      for (const request of requests) {
        await expect(session.execute("browser_cdp", request)).rejects.toThrow("private login data");
      }
      expect(protocolSessions).toBe(0);
      expect(await page.evaluate(() => (globalThis as any).__privateCdpAttempted)).toBeUndefined();
      const metrics = await session.execute("browser_cdp", { method: "Performance.getMetrics" });
      expect(metrics.details.method).toBe("Performance.getMetrics");
      expect(protocolSessions).toBeGreaterThan(0);
    } finally {
      await browser.close();
      await driver.stop();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
