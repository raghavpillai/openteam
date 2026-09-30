import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errors } from "undici/index.js";
import {
  builtinFetch,
  decodeWebText,
  kindOf,
  MAX_MARKDOWN_ELEMENTS,
  webMarkdown,
  WebHttpError,
  publicWebGet,
} from "../src/builtin-fetch";

type Get = typeof publicWebGet;
const url = "https://example.com/page";
const html = (body: string, title = "Fixture") =>
  Buffer.from(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
const paragraphs = "<p>Useful paragraph about the topic with real reading content for people.</p>".repeat(40);
const article = `<article><h1>Guide</h1>${paragraphs}</article>`;

test("prose in navigation-marked disclosures survives extraction while link menus do not", () => {
  const page = html(`<nav><a href="/menu">MENU_ONLY</a></nav><main>${article}
    <section><h2>Common questions</h2><div><h3>What is included?</h3>
    <nav style="height:0px"><div>Each workspace includes twelve project folders and unlimited archived records. See <a href="/limits">the limits guide</a> for exceptions.</div></nav>
    </div><div role="navigation">Exported records retain their original creation dates and author names.</div></section></main>`).toString();
  const markdown = webMarkdown(page, url);
  expect(markdown).toContain("twelve project folders and unlimited archived records");
  expect(markdown).toContain("original creation dates and author names");
  expect(markdown).toContain("https://example.com/limits");
  expect(markdown).not.toContain("MENU_ONLY");
});

test("disclosures survive enclosing chrome landmarks and article extraction", () => {
  for (const wrapper of ["header", "footer", "aside"]) {
    const page = html(`<main>${article}<${wrapper}><nav>Archived records retain their original owners and timestamps.</nav><nav><a href="/menu">MENU_ONLY</a></nav></${wrapper}><details><summary>Export policy</summary><p>Exports include every archived record and its original identifier.</p></details></main>`).toString();
    const markdown = webMarkdown(page, url);
    expect(markdown).toContain("original owners and timestamps");
    expect(markdown).toContain("every archived record and its original identifier");
    expect(markdown).not.toContain("MENU_ONLY");
  }
  const standalone = webMarkdown(html(`${article}<details><summary>Export policy</summary><p>All archived records remain exportable.</p></details><details hidden>HIDDEN_DISCLOSURE</details>`).toString(), url);
  expect(standalone).toContain("All archived records remain exportable.");
  expect(standalone).not.toContain("HIDDEN_DISCLOSURE");
});

test("article extraction cannot drop a short sibling from an explicit main region", () => {
  for (const region of ["<main>", '<div role="main">']) {
    const close = region === "<main>" ? "</main>" : "</div>";
    const markdown = webMarkdown(html(`${region}${article}<section>Exports retain original timestamps and include archived records.</section>${close}`).toString(), url);
    expect(markdown).toContain("Exports retain original timestamps and include archived records.");
  }
});

test("public fetch cancels while DNS is pending and does not continue after late resolution", async () => {
  const controller = new AbortController();
  let resolveDns!: (value: Array<{ address: string; family: number }>) => void;
  let calls = 0;
  const pending = publicWebGet("https://example.com/", controller.signal, undefined, () => {
    calls++;
    return new Promise(resolve => { resolveDns = resolve; });
  }).then(() => "unexpected success", error => error);
  const reason = new Error("User cancelled during DNS");
  controller.abort(reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve("still pending"), 100); })]);
    expect(result).toBe(reason);
    expect(calls).toBe(1);
  } finally {
    clearTimeout(timer);
    // A private address makes any accidental continuation observable without
    // permitting a network connection from this regression fixture.
    resolveDns([{ address: "127.0.0.1", family: 4 }]);
  }
  expect(await pending).toBe(reason);
});

test("DNS cancellation retains pre-abort and private-address guards", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Already stopped"));
  let calls = 0;
  await expect(publicWebGet("https://example.com/", controller.signal, undefined, async () => {
    calls++;
    return [{ address: "127.0.0.1", family: 4 }];
  })).rejects.toThrow("Already stopped");
  expect(calls).toBe(0);
  await expect(publicWebGet("https://example.com/", undefined, undefined, async () => [
    { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
  ])).rejects.toThrow("Private and local network destinations are not allowed");
  await expect(publicWebGet("https://example.com/", undefined, undefined, async () => {
    throw new Error("Resolver unavailable");
  })).rejects.toThrow("Resolver unavailable");
});

test("markdown preserves explicitly labelled SVG evidence without guessing decorative icons", () => {
  const markdown = webMarkdown(html(`<main><h1>Service comparison</h1><table>
    <tr><th>Feature</th><th>Basic</th><th>Team</th></tr>
    <tr><td>Shared scheduling</td><td><svg role="img" aria-label="Not included"><path/></svg></td><td><svg><title>Included</title><path/></svg></td></tr>
    <tr><td>Exports</td><td><svg aria-labelledby="export-label"><title id="export-label">Available with add-on</title></svg></td><td><svg aria-hidden="true"><title>HIDDEN_ICON</title></svg></td></tr>
    </table><svg><path id="DECORATIVE_PATH"/></svg><svg><script>ACTIVE_SCRIPT</script></svg>
    <button><svg aria-label="PRIVATE_BUTTON"/></button></main>`).toString(), url);
  expect(markdown).toContain("| Shared scheduling | Not included | Included |");
  expect(markdown).toContain("| Exports | Available with add-on |  |");
  for (const hidden of ["HIDDEN_ICON", "DECORATIVE_PATH", "ACTIVE_SCRIPT", "PRIVATE_BUTTON"])
    expect(markdown).not.toContain(hidden);
});

test("text decoding honors header, BOM, meta and XML charset declarations", () => {
  const shiftJis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]); // 日本
  expect(decodeWebText(shiftJis, "text/html; charset=Shift_JIS")).toBe("日本");
  expect(
    decodeWebText(Buffer.concat([Buffer.from('<meta charset="shift_jis">'), shiftJis]), "text/html")
  ).toContain("日本");
  expect(
    decodeWebText(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?>'), shiftJis]), "application/xml")
  ).toContain("日本");
  expect(decodeWebText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), "text/plain; charset=latin1")).toBe("hi");
  expect(decodeWebText(Buffer.from([0xe9]), "text/plain; charset=iso-8859-1")).toBe("é");
  expect(decodeWebText(Buffer.from("plain"), "text/plain; charset=not-a-charset")).toBe("plain");
});

test("content kinds are sniffed when servers omit or misstate the type", () => {
  const kind = (bytes: Buffer | string, contentType: string) =>
    kindOf({ url, bytes: Buffer.from(bytes), contentType });
  expect(kind("%PDF-1.4 ...", "application/octet-stream")).toBe("pdf");
  expect(kind("%PDF-1.4 ...", "")).toBe("pdf");
  expect(kind("<!DOCTYPE html><p>x", "")).toBe("html");
  expect(kind("<p>x", "application/xhtml+xml")).toBe("html");
  for (const type of ["application/rss+xml", "application/atom+xml; charset=utf-8", "application/ld+json", "text/csv", "application/x-ndjson"])
    expect(kind("data", type)).toBe("text");
  expect(kind("plain words", "")).toBe("text");
  expect(kind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), "")).toBe("binary");
  expect(kind("GIF89a", "image/gif")).toBe("binary");
});

test("markdown keeps data tables that article extraction would drop", () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<tr><td>Country ${i}</td><td>${(i + 1) * 1_000_000}</td></tr>`).join("");
  const page = html(
    `<nav><a href="/a">Home</a></nav><p>As of 2026 the most populous country is listed first.</p>
     <table><caption>Population by country</caption><tr><th>Country</th><th>Population</th></tr>${rows}</table>
     <footer>Footer links</footer>`
  ).toString();
  const markdown = webMarkdown(page, url);
  expect(markdown).toContain("**Population by country**");
  expect(markdown).toContain("| Country | Population |");
  expect(markdown).toContain("| Country 29 | 30000000 |");
});

test("markdown keeps whole-page forms, landmark-wrapped content and drops noise", () => {
  const aspNet = webMarkdown(
    html(`<form id="aspnetForm"><input type="hidden" name="__VIEWSTATE" value="PRIVATE_STATE"><main>${article}</main><button>Submit PRIVATE_BUTTON</button></form>`).toString(),
    url
  );
  expect(aspNet).toContain("Useful paragraph about the topic");
  expect(aspNet).not.toContain("PRIVATE_");
  const products = Array.from({ length: 20 }, (_, i) => `<li>iPhone model ${i} from $${799 + i}</li>`).join("");
  const landmark = webMarkdown(html(`<footer role="contentinfo"><h2>Shop iPhone</h2><ul>${products}</ul></footer>`).toString(), url);
  expect(landmark).toContain("iPhone model 19 from $818");
  const links = webMarkdown(
    html(`<article><p>Read the <a href="/source" title="Tooltip text">source</a>. <a href="/empty"></a><img src="/x.png" alt="A chart"><img src="/y.png"></p>${paragraphs}</article>`).toString(),
    url
  );
  expect(links).toContain("[source](https://example.com/source)");
  expect(links).not.toContain("Tooltip text");
  expect(links).not.toContain("https://example.com/empty");
  expect(links).toContain("[image: A chart]");
  expect(links).not.toContain("y.png");
});

const fakeGet = (respond: (headers: Record<string, string>) => { bytes: Buffer; contentType?: string } | Error) => {
  const calls: string[] = [];
  const get: Get = async (target, _signal, headers = {}) => {
    calls.push(headers["user-agent"] ?? "");
    const response = respond(headers);
    if (response instanceof Error) throw response;
    return { url: target, bytes: response.bytes, contentType: response.contentType ?? "text/html; charset=utf-8" };
  };
  return { get, calls };
};
const isBrowser = (headers: Record<string, string>) => headers["user-agent"]!.includes("Mozilla");

test("an honest request that succeeds is not retried", async () => {
  const { get, calls } = fakeGet(() => ({ bytes: html(article) }));
  const page = await builtinFetch(url, undefined, get);
  expect(calls).toEqual(["OpenTeam-WebFetch/1.0"]);
  expect(page).toMatchObject({ url, retriedWithBrowserHeaders: false });
  expect(page.note).toBeUndefined();
  expect(page.text).toContain("Useful paragraph");
});

test("blocked or JavaScript-shell pages retry once with browser headers", async () => {
  const blocked = fakeGet((headers) => (isBrowser(headers) ? { bytes: html(article) } : new WebHttpError(403)));
  const unblocked = await builtinFetch(url, undefined, blocked.get);
  expect(blocked.calls).toHaveLength(2);
  expect(unblocked.retriedWithBrowserHeaders).toBe(true);
  expect(unblocked.text).toContain("Useful paragraph");

  const shell = fakeGet((headers) => ({ bytes: html(isBrowser(headers) ? article : '<div id="root"></div>') }));
  const rendered = await builtinFetch(url, undefined, shell.get);
  expect(rendered.retriedWithBrowserHeaders).toBe(true);
  expect(rendered.note).toBeUndefined();

  const stillShell = fakeGet(() => ({ bytes: html('<div id="root">Loading</div>') }));
  const thin = await builtinFetch(url, undefined, stillShell.get);
  expect(stillShell.calls).toHaveLength(2);
  expect(thin.note).toContain("needs JavaScript");

  const challenge = fakeGet(() => ({ bytes: html("<h1>Just a moment...</h1><p>Checking your browser before accessing.</p>") }));
  expect((await builtinFetch(url, undefined, challenge.get)).note).toContain("bot check");
});

test("hard blocks explain the browser fallback; other failures are not retried", async () => {
  const wall = fakeGet(() => new WebHttpError(403));
  await expect(builtinFetch(url, undefined, wall.get)).rejects.toThrow(
    "Web request failed with HTTP 403. The site blocks automated fetching; open it with the browser tool instead"
  );
  expect(wall.calls).toHaveLength(2);
  for (const failure of [new WebHttpError(404), new Error("Private and local network destinations are not allowed")]) {
    const once = fakeGet(() => failure);
    await expect(builtinFetch(url, undefined, once.get)).rejects.toThrow(failure.message);
    expect(once.calls).toHaveLength(1);
  }
  const image = fakeGet(() => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), contentType: "image/png" }));
  await expect(builtinFetch(url, undefined, image.get)).rejects.toThrow("WebFetch received image/png; download this file with Shell instead");
  expect(image.calls).toHaveLength(1);
});

test("dropped connections are retried once", async () => {
  const dropped = fakeGet((headers) => (isBrowser(headers) ? { bytes: html(article) } : new errors.ConnectTimeoutError()));
  const page = await builtinFetch(url, undefined, dropped.get);
  expect(dropped.calls).toHaveLength(2);
  expect(page.text).toContain("Useful paragraph");

  const down = fakeGet(() => new errors.ConnectTimeoutError());
  await expect(builtinFetch(url, undefined, down.get)).rejects.toThrow("Connect Timeout Error");
  expect(down.calls).toHaveLength(2);
});

test("pages too large to convert quickly come back as plain text with a note", async () => {
  const list = (items: number) =>
    html(
      `<h1>Spec</h1><table><tr><th>Term</th><th>Meaning</th></tr><tr><td>alpha</td><td>first</td></tr></table>` +
        `<ul>${Array.from({ length: items }, (_, i) => `<li><a href="/item/${i}">Item ${i}</a></li>`).join("")}</ul>`
    );
  const items = MAX_MARKDOWN_ELEMENTS / 2 + 10;
  const { get } = fakeGet(() => ({ bytes: list(items) }));
  const page = await builtinFetch(url, undefined, get);
  expect(page.note).toContain("very large");
  expect(page.text).toStartWith("# Fixture\n\nSpec\n");
  expect(page.text).toContain(`Item 0\nItem 1\n`);
  expect(page.text).toContain(`Item ${items - 1}`);
  expect(page.text).toContain("Term | Meaning\nalpha | first\n");
  expect(page.text).not.toContain("](https://example.com/item/");

  const smaller = webMarkdown(list(100).toString(), url);
  expect(smaller).toContain("[Item 99](https://example.com/item/99)");
  expect(smaller).toContain("| alpha | first |");
});

test("feeds, JSON and non-UTF-8 text come back as text", async () => {
  const feed = fakeGet(() => ({ bytes: Buffer.from("<feed><title>Bun v1.4.2</title></feed>"), contentType: "application/atom+xml" }));
  expect((await builtinFetch(url, undefined, feed.get)).text).toContain("Bun v1.4.2");
  const japanese = fakeGet(() => ({
    bytes: Buffer.concat([Buffer.from('<html><head><meta charset="shift_jis"><title>t</title></head><body><article><p>'), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from(`</p>${paragraphs}</article></body></html>`)]),
    contentType: "text/html",
  }));
  expect((await builtinFetch(url, undefined, japanese.get)).text).toContain("日本");
});

test.skipIf(!Bun.which("pdftotext"))("PDFs are converted to text", async () => {
  const pdf = await readFile(join(import.meta.dir, "fixtures", "input-parity", "fixture.pdf"));
  const { get } = fakeGet(() => ({ bytes: pdf, contentType: "application/pdf" }));
  const page = await builtinFetch(url, undefined, get);
  expect(page.text).toContain("PDF_VIOLET_284");
});

test("short complete pages are neither retried nor labeled JavaScript shells", async () => {
  const { get, calls } = fakeGet(() => ({ bytes: html('<h1>Example Domain</h1><p>This domain is for use in documentation examples.</p>') }));
  const page = await builtinFetch(url, undefined, get);
  expect(calls).toHaveLength(1);
  expect(page.note).toBeUndefined();
});

test("extraction separates structured offers from visible shipping and removes statically hidden text", () => {
  const page = html(`<style>.hidden {display:none} .shown {display:none} .shown {display:block} @media print {.print {display:none}}</style>
    <p class="hidden">Free shipping HIDDEN_CSS</p><p hidden>HIDDEN_ATTRIBUTE</p>
    <p aria-hidden="true">HIDDEN_ARIA</p><p style="display:none !important">HIDDEN_INLINE</p>
    <p class="hidden" style="display:block">Visible override</p><p class="shown">Visible cascade</p>
    <p class="print">Visible screen</p><p>Shipping: $50</p>
    <script type="application/ld+json">{"@type":"Product","offers":{"price":9975,"priceCurrency":"USD"}}</script>
    <script type="application/ld+json">invalid PRIVATE_INVALID</script><script>PRIVATE_SCRIPT</script>`).toString();
  const result = webMarkdown(page, url);
  expect(result).not.toContain("HIDDEN_");
  expect(result).not.toContain("PRIVATE_");
  expect(result).toContain("Shipping: $50");
  expect(result).toContain("Visible override");
  expect(result).toContain("Visible cascade");
  expect(result).toContain("Visible screen");
  expect(result).toContain('"price": 9975');
  expect(result).toContain("not necessarily visible, current or applicable to your region");
});

test("structured data is bounded, inert, and cannot conceal an empty page", async () => {
  const data = JSON.stringify({ text: "```injected", price: 123 });
  const page = html(`<div id="root">Loading</div><script type="application/ld+json">${data}</script><script type="application/ld+json">${JSON.stringify({ big: 'x'.repeat(65_000) })}</script>`);
  const { get } = fakeGet(() => ({ bytes: page }));
  const result = await builtinFetch(url, undefined, get);
  expect(result.note).toContain("needs JavaScript");
  expect(result.text).toContain('"price": 123');
  expect(result.text).not.toContain("```injected");
  expect(result.text).not.toContain('"big"');
});

test("a short genuine retry wins over a larger challenge page", async () => {
  const { get } = fakeGet(headers => ({ bytes: html(isBrowser(headers)
    ? '<p>Shipping: $50</p>'
    : '<p>Checking your browser. Verify you are human before continuing to the requested shopping page.</p>') }));
  const result = await builtinFetch(url, undefined, get);
  expect(result.text).toContain("Shipping: $50");
  expect(result.note).toBeUndefined();
  expect(result.retriedWithBrowserHeaders).toBe(true);
});

test("repeated div matrices retain empty cell positions without inventing meanings", () => {
  const matrix = `<section><h2>Starter · Team · Business · Enterprise</h2><div>
  <div><div>Members</div><div>5</div><div>5</div><div>25</div><div>Unlimited</div></div>
  <div><div>Synced users</div><div></div><div>1 user</div><div>5 users</div><div>Unlimited</div></div>
  <div><div>Advanced feature</div><div></div><div></div><div></div><div><svg><path /></svg></div></div>
  </div></section>`;
  const result = webMarkdown(html(matrix).toString(), url);
  expect(result).toContain('| Column 1 | Column 2 | Column 3 | Column 4 | Column 5 |');
  expect(result).toContain(String.raw`| Synced users | \[empty or omitted content\] | 1 user | 5 users | Unlimited |`);
  expect(result).toContain('columns are positional');
  expect(result).not.toContain('| Advanced feature | No');
  const ordinary = webMarkdown(html('<div><div><div>One</div><div>Two</div><div>Three</div></div><p>Normal content</p></div>').toString(), url);
  expect(ordinary).not.toContain('columns are positional');
  expect(ordinary).toContain('Normal content');
});
