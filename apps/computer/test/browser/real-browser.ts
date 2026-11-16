// Shared setup for suites that drive a real, isolated headless Chromium. Each
// test gets its own browser, unauthenticated context and temp root; nothing
// adopts the user's tabs. Set OPENTEAM_BROWSER_TEST_EXECUTABLE to run them.
import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUseSession } from "../../src/browser/use";
import { outOfProcessPlaywright } from "../../src/browser/playwright-driver";
import type { FormBrowser } from "../../src/user-form-host";

export const realBrowserTest = test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE);

export const text = (result: any): string =>
  result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");

/** The ref on the first snapshot line containing every needle. */
export const refIn = (snapshot: string, ...needles: string[]): string =>
  snapshot.split("\n").find((line) => line.includes("[ref=") && needles.every((needle) => line.includes(needle)))!
    .match(/\[ref=(e\d+)\]/)![1]!;

export type RealSession = {
  session: BrowserUseSession;
  browser: any;
  context: any;
  root: string;
  /** Serves static (or per-request) HTML on loopback; stopped after the test. */
  serve: (html: string | ((request: Request) => string), hostname?: string) => ReturnType<typeof Bun.serve>;
  /** Navigates to about:blank and replaces its content. */
  blank: (html: string) => Promise<any>;
  page: () => Promise<any>;
};

export async function withRealSession(run: (s: RealSession) => Promise<void>, args: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "openteam-browser-"));
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const driver = await outOfProcessPlaywright();
  const browser = await driver.playwright.chromium.launch({
    headless: true,
    executablePath: process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE,
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), ...args],
  });
  try {
    const context = await browser.newContext();
    const session = new (BrowserUseSession as any)(browser, context, root) as BrowserUseSession;
    const page = () => (session as any).ensurePage();
    await run({
      session, browser, context, root, page,
      serve: (html, hostname = "127.0.0.1") => {
        const server = Bun.serve({ hostname, port: 0, fetch: (request) =>
          new Response(typeof html === "string" ? html : html(request), { headers: { "content-type": "text/html; charset=utf-8" } }) });
        servers.push(server);
        return server;
      },
      blank: async (html) => {
        await session.execute("browser_navigate", { url: "about:blank" });
        const live = await page();
        await live.setContent(html);
        return live;
      },
    });
  } finally {
    await browser.close();
    await driver.stop();
    for (const server of servers) server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

export const formAdapter = (session: BrowserUseSession): FormBrowser => ({
  prepare: async (form) => {
    const [binding] = await session.formPages(form.domain!);
    return { binding: binding!, ...await session.prepareForm(binding!, form) };
  },
  rebind: (binding, form) => session.rebindForm(binding, form),
  fill: (binding, field, value) => session.fillForm(binding, field, value),
  submit: (binding, field) => session.submitForm(binding, field),
  snapshot: (binding) => session.formSnapshot(binding),
});
