import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  builtinFetch,
  decodeWebText,
  kindOf,
  webMarkdown,
  WebHttpError,
  type publicWebGet,
} from "../src/builtin-fetch";

type Get = typeof publicWebGet;
const url = "https://example.com/page";
const html = (body: string, title = "Fixture") =>
  Buffer.from(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
const paragraphs = "<p>Useful paragraph about the topic with real reading content for people.</p>".repeat(40);
const article = `<article><h1>Guide</h1>${paragraphs}</article>`;

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
