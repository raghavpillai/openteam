import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errors } from "undici/index.js";
import { builtinFetch, kindOf, MAX_MARKDOWN_ELEMENTS, MAX_WEB_DOWNLOAD, webMarkdown, WebHttpError, publicWebGet } from "../src/builtin-fetch";
import { isPublicAddress, publicWebUrl } from "../src/public-web-url";

type Get = typeof publicWebGet;
const url = "https://example.com/page";
const html = (body: string, title = "Fixture") =>
  Buffer.from(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
const paragraphs = "<p>Useful paragraph about the topic with real reading content for people.</p>".repeat(40);
const article = `<article><h1>Guide</h1>${paragraphs}</article>`;

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

test.each([
  ["relative directory", '<base href="/archives/2024/">', "record.html", "https://example.org/archives/2024/record.html"],
  ["cross-origin base", '<base href="https://data.example.net/releases/">', "table.csv", "https://data.example.net/releases/table.csv"],
  ["first href wins", '<base target="_blank"><base href="/first/"><base href="/second/">', "item", "https://example.org/first/item"],
  ["invalid first stays fallback", '<base href="http://["><base href="/second/">', "item", "https://example.org/news/current/item"],
  ["javascript base rejected", '<base href="javascript:alert(1)">', "item", "https://example.org/news/current/item"],
  ["no base unchanged", "", "../source", "https://example.org/news/source"],
])("links resolve against <base>: %s", (_name, head, href, expected) => {
  const result = webMarkdown(`<html><head>${head}</head><body><p>Read <a href="${href}">source</a>.</p></body></html>`, "https://example.org/news/current/page");
  expect(result).toContain(`[source](${expected})`);
});

test("base resolution never emits executable or local-file links", () => {
  const result = webMarkdown('<html><head><base href="file:///tmp/"></head><body><p><a href="private.txt">local</a> <a href="javascript:alert(1)">script</a> <a href="https://example.net/ok">public</a></p></body></html>', "https://example.org/page");
  expect(result).not.toContain("file:");
  expect(result).not.toContain("javascript:");
  expect(result).toContain("[public](https://example.net/ok)");
});

test("PDF extraction keeps output at the limit and refuses silent truncation past it", async () => {
  // A controlled extractor exercises the real child-process boundary.
  const dir = await mkdtemp(join(tmpdir(), "fetch-pdf-output-"));
  const originalPath = process.env.PATH;
  const pdfUrl = "https://example.com/report.pdf";
  const get = (async () => ({ url: pdfUrl, bytes: Buffer.from("%PDF-extractor-test"), contentType: "application/pdf" })) as Get;
  try {
    await chmod(dir, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? "/usr/bin:/bin"}`;
    for (const size of [MAX_WEB_DOWNLOAD, MAX_WEB_DOWNLOAD + 1]) {
      await writeFile(join(dir, "pdftotext"), `#!/usr/bin/env python3\nimport sys\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(b'x' * ${size})\n`, { mode: 0o755 });
      if (size > MAX_WEB_DOWNLOAD) await expect(builtinFetch(pdfUrl, undefined, get)).rejects.toThrow(/PDF.*text.*limit.*download/i);
      else expect((await builtinFetch(pdfUrl, undefined, get)).text.length).toBe(MAX_WEB_DOWNLOAD);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("public web reader blocks private, encoded, credentialed and non-HTTP destinations", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress("1.1.1.1")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  for (const url of [
    "file:///etc/passwd",
    "http://localhost",
    "http://2130706433",
    "http://0x7f000001",
    "http://[::ffff:7f00:1]",
    "https://user:pass@example.com",
  ])
    expect(() => publicWebUrl(url)).toThrow();
  await expect(publicWebGet("http://127.0.0.1/")).rejects.toThrow();
  // Literal local and private hosts get the reference's explanation.
  expect(() => publicWebUrl("http://localhost:3000/app")).toThrow("Cannot fetch from localhost (localhost:3000) because this tool runs from an isolated server.");
  expect(() => publicWebUrl("http://127.0.0.1/")).toThrow("Cannot fetch from localhost (127.0.0.1) because this tool runs from an isolated server.");
  expect(() => publicWebUrl("http://[::1]:8080/")).toThrow("Cannot fetch from localhost ([::1]:8080) because this tool runs from an isolated server.");
  expect(() => publicWebUrl("http://192.168.1.10:8000/")).toThrow("Cannot fetch from private IP (192.168.1.10:8000) because this tool runs from an isolated server.");
  expect(() => publicWebUrl("http://printer.local/")).toThrow("Private and local network destinations are not allowed");
});

test("HTML conversion keeps article structure and absolute citations without active content", () => {
  const html =
    '<html><head><title>Test</title><script>PRIVATE_SCRIPT</script></head><body><article><h1>Heading</h1><p>Useful article with a <a href="/source">citation</a> and <strong>detail</strong>.</p><pre><code>const value = 1;</code></pre></article><form><input value="PRIVATE_FIELD"></form></body></html>';
  const result = webMarkdown(html, "https://example.com/page");
  expect(result).toContain("# Heading");
  expect(result).toContain("[citation](https://example.com/source)");
  expect(result).toContain("const value = 1;");
  expect(result).not.toContain("PRIVATE_");
});
