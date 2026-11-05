import { expect, test } from "bun:test";
import { boxHelpPage } from "../src/box-help-page";
import { BrowserUseSession } from "../src/browser/use";
import { RuntimeTools } from "../src/runtime/tools";

test("a handoff page counts only on the destination's site or the IdP host", () => {
  expect(boxHelpPage({ domain: "www.Example.com", url: "https://app.example.com/login" }))
    .toEqual({ hosts: ["app.example.com", "example.com"], domain: "example.com", url: "https://app.example.com/login" });
  expect(boxHelpPage({ domain: "example.com", idp_domain: "accounts.idp.test", url: "accounts.idp.test/sso" }))
    .toEqual({ hosts: ["accounts.idp.test", "example.com"], domain: "example.com", url: "https://accounts.idp.test/sso" });
  // Any other address is ignored; the tab search still uses the step's hosts.
  for (const url of ["https://evil.test/example.com", "javascript:alert(1)", "file:///etc/passwd", "https://notexample.com/"])
    expect(boxHelpPage({ domain: "example.com", url })).toEqual({ hosts: ["example.com"], domain: "example.com" });
  expect(boxHelpPage({ url: "https://example.com" })).toBeUndefined();
  expect(boxHelpPage({})).toBeUndefined();
});

function session(urls: string[]) {
  const browser = Object.create(BrowserUseSession.prototype) as any;
  const events: string[] = [];
  const page = (url: string, id: string) => ({
    id, url: () => url,
    bringToFront: async () => { events.push(`front ${id}`); },
    goto: async (target: string) => { events.push(`goto ${id} ${target}`); },
  });
  const pages = urls.map((url, index) => page(url, `tab-${index}`));
  browser.leasedPages = () => pages;
  browser.idFor = (target: any) => target.id;
  browser.ensurePage = async () => pages[0] ?? page("about:blank", "new");
  return { browser, events };
}

test("the browser brings a matching tab forward, or opens the address only when no web page is open", async () => {
  const exactHost = session(["https://other.test/", "https://example.com/", "https://accounts.idp.test/sso"]);
  expect(await exactHost.browser.presentHandoffPage({ hosts: ["accounts.idp.test", "example.com"], domain: "example.com" })).toBe("focused");
  expect(exactHost.events).toEqual(["front tab-2"]);
  expect(exactHost.browser.currentViewId).toBe("tab-2");

  const sameSite = session(["https://mail.example.com/inbox"]);
  expect(await sameSite.browser.presentHandoffPage({ hosts: ["example.com"], domain: "example.com", url: "https://example.com/login" })).toBe("focused");
  expect(sameSite.events).toEqual(["front tab-0"]);

  const blank = session(["about:blank"]);
  expect(await blank.browser.presentHandoffPage({ hosts: ["example.com"], domain: "example.com", url: "https://example.com/login" })).toBe("opened");
  expect(blank.events).toEqual(["front tab-0", "goto tab-0 https://example.com/login"]);

  // Another site's work is never navigated away.
  const busy = session(["https://other.test/cart"]);
  expect(await busy.browser.presentHandoffPage({ hosts: ["example.com"], domain: "example.com", url: "https://example.com/login" })).toBe("unchanged");
  expect(busy.events).toEqual([]);
});

test("request_box_help prepares the page before the handoff and still hands off when the browser fails", async () => {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const order: string[] = [];
  tools.callControlPlaneToolRequest = async (_active: any, _id: string, tool: string) => { order.push(`send ${tool}`); return { content: [], details: {} }; };
  tools.privateBrowser = async () => ({ presentHandoffPage: async (target: any) => { order.push(`page ${target.url}`); return "opened"; } });
  const active = { botId: "bot", screenBotId: "bot" };
  await tools.callControlPlaneTool(active, "help", "request_box_help", { instruction: "Sign in", domain: "example.com", url: "https://example.com/login" });
  expect(order).toEqual(["page https://example.com/login", "send request_box_help"]);

  order.length = 0;
  tools.privateBrowser = async () => { throw new Error("no desktop"); };
  await tools.callControlPlaneTool(active, "help-2", "request_box_help", { instruction: "Sign in", domain: "example.com", url: "https://example.com/login" });
  expect(order).toEqual(["send request_box_help"]);

  // Without an address, a browser that is not running is left alone.
  order.length = 0;
  let opened = false;
  tools.privateBrowser = async () => { opened = true; throw new Error("unexpected launch"); };
  await tools.callControlPlaneTool(active, "help-3", "request_box_help", { instruction: "Approve on your phone", domain: "example.com" });
  expect(opened).toBe(false);
  expect(order).toEqual(["send request_box_help"]);
});
