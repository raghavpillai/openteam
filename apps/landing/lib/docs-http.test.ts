import { describe, expect, test } from "bun:test";
import { compileDocs } from "../scripts/build-docs";
import { DOCS_ORIGIN } from "./docs-types";
import { docsTextResponse, preferredTextType } from "./docs-http";

const data = compileDocs();
const origin = "http://100.94.42.50:5106";
const request = (path: string, accept?: string, method = "GET") => new Request(`${origin}${path}`, {
  method,
  headers: accept ? { Accept: accept } : {},
});

describe("documentation HTTP representations", () => {
  test("negotiates explicit text preferences without hijacking browsers or wildcards", () => {
    for (const accept of [null, "*/*", "text/html,application/xhtml+xml,*/*;q=0.8", "text/markdown;q=0", "text/markdown;q=0.3,text/html;q=0.9", "text/plain;q=nope"]) {
      expect(preferredTextType(accept)).toBeUndefined();
    }
    expect(preferredTextType("text/markdown")).toBe("text/markdown");
    expect(preferredTextType("text/plain")).toBe("text/plain");
    expect(preferredTextType("text/plain;q=0.4, text/markdown;q=0.9")).toBe("text/markdown");
    expect(preferredTextType("text/html;q=0, text/markdown;q=0.5, */*;q=1")).toBe("text/markdown");
  });

  test("every published .md URL and negotiated URL serve the same complete page", async () => {
    for (const page of data.pages) {
      const explicit = docsTextResponse(request(`/docs/${page.slug}.md`), data.text)!;
      const negotiated = docsTextResponse(request(page.href, "text/markdown"), data.text)!;
      expect(explicit.status).toBe(200);
      expect(explicit.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
      const body = await explicit.text();
      expect(await negotiated.text()).toBe(body);
      expect(body).toContain(`# ${page.title}\n`);
      expect(body).not.toContain(DOCS_ORIGIN);
      expect(body).not.toContain("<!DOCTYPE");
      expect(explicit.headers.get("Vary")).toContain("Accept");
      expect(explicit.headers.get("X-Llms-Txt")).toBe("/llms.txt");
    }
  });

  test("provides valid grouped indexes, all resolvable links, and one copy of every full guide", async () => {
    const index = await docsTextResponse(request("/llms.txt"), data.text)!.text();
    expect(index).toStartWith("# OpenTeam Documentation\n\n> ");
    expect(index.match(/^# /gm)).toHaveLength(1);
    expect(index.match(/^## /gm)).toHaveLength(data.config.groups.length);
    const links = [...index.matchAll(/^- \[.+\]\((https?:\/\/[^)]+\.md)\): .+$/gm)];
    expect(links).toHaveLength(data.pages.length);
    for (const [, url] of links) {
      expect(url.startsWith(origin)).toBe(true);
      expect(docsTextResponse(new Request(url), data.text)?.status).toBe(200);
    }
    const full = await docsTextResponse(request("/llms-full.txt"), data.text)!.text();
    expect(full.match(/^Source: /gm)).toHaveLength(data.pages.length);
    for (const page of data.pages) expect(full).toContain(`# ${page.title}\n`);
    for (const prefix of ["/docs", "/.well-known", "/docs/.well-known"]) {
      expect(await docsTextResponse(request(`${prefix}/llms.txt`), data.text)!.text()).toBe(index);
      expect(await docsTextResponse(request(`${prefix}/llms-full.txt`), data.text)!.text()).toBe(full);
    }
  });

  test("supports home aliases, HEAD, plain text, missing pages, and trailing slashes", async () => {
    const home = await docsTextResponse(request("/docs.md"), data.text)!.text();
    expect(await docsTextResponse(request("/docs/index.md"), data.text)!.text()).toBe(home);
    expect(await docsTextResponse(request("/docs/", "text/markdown"), data.text)!.text()).toBe(home);
    const head = docsTextResponse(request("/docs.md", undefined, "HEAD"), data.text)!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(docsTextResponse(request("/docs", "text/plain"), data.text)?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(docsTextResponse(request("/docs/no-such-page.md"), data.text)?.status).toBe(404);
    expect(docsTextResponse(request("/docs/no-such-page", "text/markdown"), data.text)?.status).toBe(404);
    expect(docsTextResponse(request("/docs", "text/markdown", "POST"), data.text)).toBeUndefined();
  });

  test("preserves HTML and RSC navigation and ignores spoofed forwarded origins", async () => {
    expect(docsTextResponse(request("/docs", "text/html"), data.text)).toBeUndefined();
    const rsc = request("/docs", "text/markdown");
    rsc.headers.set("RSC", "1");
    expect(docsTextResponse(rsc, data.text)).toBeUndefined();
    const forwarded = request("/llms.txt");
    forwarded.headers.set("X-Forwarded-Host", "evil.example");
    expect(await docsTextResponse(forwarded, data.text)!.text()).not.toContain("evil.example");
  });
});
